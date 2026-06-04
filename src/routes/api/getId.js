// src/routes/api/getId.js

const { Fragment } = require('../../model/fragment');
const { createErrorResponse } = require('../../response');
const logger = require('../../logger');

// Get an authenticated user's fragment data by id
module.exports = async (req, res) => {
  // Strip optional extension (e.g. ".txt") — conversions added in later assignments
  const id = req.params.id.split('.')[0];

  try {
    const fragment = await Fragment.byId(req.user, id);
    const data = await fragment.getData();
    res.setHeader('Content-Type', fragment.type);
    res.status(200).send(data);
  } catch (err) {
    logger.warn({ err, id }, 'Fragment not found');
    res.status(404).json(createErrorResponse(404, 'Fragment not found'));
  }
};
