// src/routes/api/put.js

const contentType = require('content-type');
const { Fragment } = require('../../model/fragment');
const { createSuccessResponse, createErrorResponse } = require('../../response');
const logger = require('../../logger');

// Update an authenticated user's existing fragment's data (type is immutable)
module.exports = async (req, res) => {
  const { id } = req.params;

  let fragment;
  try {
    fragment = await Fragment.byId(req.user, id);
  } catch (err) {
    logger.warn({ err, id }, 'Fragment not found');
    return res.status(404).json(createErrorResponse(404, 'Fragment not found'));
  }

  const rawContentType = req.get('Content-Type');
  if (!rawContentType) {
    logger.warn({ id }, 'Missing Content-Type header');
    return res.status(400).json(createErrorResponse(400, 'Missing Content-Type header'));
  }
  const { type } = contentType.parse(rawContentType);

  if (type !== fragment.mimeType) {
    logger.warn(
      { id, existingType: fragment.mimeType, newType: type },
      "Content-Type doesn't match fragment's existing type"
    );
    return res
      .status(400)
      .json(createErrorResponse(400, "A fragment's type cannot be changed after it is created"));
  }

  if (!Buffer.isBuffer(req.body)) {
    logger.warn({ id, type: req.get('Content-Type') }, 'Unsupported Content-Type');
    return res.status(400).json(createErrorResponse(400, 'Unsupported Content-Type'));
  }

  try {
    await fragment.setData(req.body);
    logger.info({ id: fragment.id, ownerId: req.user }, 'Updated fragment');
    res.status(200).json(createSuccessResponse({ fragment }));
  } catch (err) {
    logger.error({ err, id }, 'Error updating fragment');
    res.status(500).json(createErrorResponse(500, 'Unable to update fragment'));
  }
};
