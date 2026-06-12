// src/routes/api/getIdInfo.js

const { Fragment } = require('../../model/fragment');
const { createSuccessResponse, createErrorResponse } = require('../../response');
const logger = require('../../logger');

// Get an authenticated user's fragment metadata (info) by id
module.exports = async (req, res) => {
  const { id } = req.params;

  try {
    const fragment = await Fragment.byId(req.user, id);
    res.status(200).json(createSuccessResponse({ fragment }));
  } catch (err) {
    logger.warn({ err, id }, 'Fragment not found');
    res.status(404).json(createErrorResponse(404, 'Fragment not found'));
  }
};
