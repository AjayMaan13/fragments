// src/routes/api/delete.js

const { Fragment } = require('../../model/fragment');
const { createSuccessResponse, createErrorResponse } = require('../../response');
const logger = require('../../logger');

// Delete an authenticated user's fragment (metadata and data) by id
module.exports = async (req, res) => {
  const { id } = req.params;

  try {
    // Make sure the fragment exists (and belongs to this user) before deleting it
    await Fragment.byId(req.user, id);
    await Fragment.delete(req.user, id);
    res.status(200).json(createSuccessResponse());
  } catch (err) {
    logger.warn({ err, id }, 'Fragment not found');
    res.status(404).json(createErrorResponse(404, 'Fragment not found'));
  }
};
