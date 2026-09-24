// src/routes/api/share.js

const { Fragment } = require('../../model/fragment');
const { createSuccessResponse, createErrorResponse } = require('../../response');
const logger = require('../../logger');

const DEFAULT_EXPIRES_IN = 15 * 60;
// Links are signed with the ECS task role's temporary credentials, which
// rotate; a link can't outlive them, so we don't promise more than an hour.
const MAX_EXPIRES_IN = 60 * 60;

// Create a temporary public link to one of the authenticated user's fragments.
// Optionally pass `?expiresIn=<seconds>` (default 15 minutes, max 1 hour).
module.exports = async (req, res) => {
  const { id } = req.params;

  let expiresIn = DEFAULT_EXPIRES_IN;
  if (req.query.expiresIn !== undefined) {
    expiresIn = Number(req.query.expiresIn);
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_EXPIRES_IN) {
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
  }

  let fragment;
  try {
    fragment = await Fragment.byId(req.user, id);
  } catch (err) {
    logger.warn({ err, id }, 'Fragment not found');
    return res.status(404).json(createErrorResponse(404, 'Fragment not found'));
  }

  try {
    const share = await fragment.createShareLink(expiresIn);
    if (!share) {
      return res
        .status(501)
        .json(
          createErrorResponse(501, 'Share links need S3 storage (not available in memory mode)')
        );
    }
    logger.info({ id, ownerId: req.user, expiresIn: share.expiresIn }, 'Created share link');
    res.status(200).json(createSuccessResponse(share));
  } catch (err) {
    logger.error({ err, id }, 'Error creating share link');
    res.status(500).json(createErrorResponse(500, 'Unable to create share link'));
  }
};
