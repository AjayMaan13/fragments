// src/routes/api/search.js

const { search, isEnabled } = require('../../search');
const { createSuccessResponse, createErrorResponse } = require('../../response');
const logger = require('../../logger');

const MAX_QUERY_LENGTH = 500;
const DEFAULT_K = 5;
const MAX_K = 20;

// GET /v1/search?q=<text>&k=<1-20>   the user's own text fragments, best match first
module.exports = async (req, res) => {
  if (!isEnabled()) {
    return res
      .status(501)
      .json(
        createErrorResponse(501, 'Search needs the embeddings table (not available in memory mode)')
      );
  }

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q || q.length > MAX_QUERY_LENGTH) {
    return res
      .status(400)
      .json(
        createErrorResponse(400, `q is required and must be at most ${MAX_QUERY_LENGTH} characters`)
      );
  }

  let k = DEFAULT_K;
  if (req.query.k !== undefined) {
    k = Number(req.query.k);
    if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
      return res
        .status(400)
        .json(createErrorResponse(400, `k must be a whole number from 1 to ${MAX_K}`));
    }
  }

  try {
    const results = await search(req.user, q, k);
    res.status(200).json(createSuccessResponse({ query: q, results }));
  } catch (err) {
    logger.error({ err }, 'Error searching fragments');
    res.status(500).json(createErrorResponse(500, 'Unable to search'));
  }
};
