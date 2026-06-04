// src/routes/api/get.js

const { Fragment } = require('../../model/fragment');
const { createSuccessResponse, createErrorResponse } = require('../../response');
const logger = require('../../logger');

// Get a list of fragments for the current user
module.exports = async (req, res) => {
  try {
    const expand = req.query.expand === '1';
    const fragments = await Fragment.byUser(req.user, expand);
    res.status(200).json(createSuccessResponse({ fragments }));
  } catch (err) {
    logger.error({ err }, 'Error listing fragments');
    res.status(500).json(createErrorResponse(500, 'Unable to list fragments'));
  }
};
