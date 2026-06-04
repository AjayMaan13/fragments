// src/routes/api/post.js

const { Fragment } = require('../../model/fragment');
const { createSuccessResponse, createErrorResponse } = require('../../response');
const logger = require('../../logger');

// Create a new fragment for the authenticated user
module.exports = async (req, res) => {
  // If the raw body parser couldn't parse it, req.body is NOT a Buffer
  if (!Buffer.isBuffer(req.body)) {
    logger.warn({ type: req.get('Content-Type') }, 'Unsupported Content-Type');
    return res.status(415).json(createErrorResponse(415, 'Unsupported Content-Type'));
  }

  try {
    const fragment = new Fragment({
      ownerId: req.user,
      type: req.get('Content-Type'),
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
