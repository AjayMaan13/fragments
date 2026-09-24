// src/routes/api/post.js

const { Fragment } = require('../../model/fragment');
const { createSuccessResponse, createErrorResponse } = require('../../response');
const logger = require('../../logger');

// Longest allowed lifetime for an expiring fragment: 30 days, in seconds
const MAX_EXPIRES_IN = 60 * 60 * 24 * 30;

// Create a new fragment for the authenticated user. Optionally pass
// `?expiresIn=<seconds>` to make it expire (and be deleted) after that long.
module.exports = async (req, res) => {
  // If the raw body parser couldn't parse it, req.body is NOT a Buffer
  if (!Buffer.isBuffer(req.body)) {
    logger.warn({ type: req.get('Content-Type') }, 'Unsupported Content-Type');
    return res.status(415).json(createErrorResponse(415, 'Unsupported Content-Type'));
  }

  let expiresAt;
  if (req.query.expiresIn !== undefined) {
    const seconds = Number(req.query.expiresIn);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_EXPIRES_IN) {
      logger.warn({ expiresIn: req.query.expiresIn }, 'Invalid expiresIn');
      return res
        .status(400)
        .json(
          createErrorResponse(
            400,
            `expiresIn must be a whole number of seconds (1-${MAX_EXPIRES_IN})`
          )
        );
    }
    // DynamoDB's TTL feature needs Unix time in seconds
    expiresAt = Math.floor(Date.now() / 1000) + seconds;
  }

  try {
    const fragment = new Fragment({
      ownerId: req.user,
      type: req.get('Content-Type'),
      expiresAt,
    });
    await fragment.save();
    await fragment.setData(req.body);

    logger.info({ id: fragment.id, ownerId: req.user }, 'Created new fragment');

    // Build the Location URL — prefer API_URL env, else fall back to request host
    const baseUrl = process.env.API_URL || `http://${req.headers.host}`;
    res.set('Location', `${baseUrl}/v1/fragments/${fragment.id}`);
    res.status(201).json(createSuccessResponse({ fragment }));
  } catch (err) {
    logger.error({ err }, 'Error creating fragment');
    res.status(500).json(createErrorResponse(500, 'Unable to create fragment'));
  }
};
