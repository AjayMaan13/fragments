// src/routes/api/jobs.js

// Asynchronous conversions: instead of converting inside the request (slow, and
// it starves other requests), record a job, queue it, and let a worker do it.

const { Fragment } = require('../../model/fragment');
const Job = require('../../model/job');
const queue = require('../../queue');
const { extToType, imageTypes, MAX_WIDTH } = require('../../convert');
const { createSuccessResponse, createErrorResponse } = require('../../response');
const logger = require('../../logger');

const notConfigured = (res) =>
  res
    .status(501)
    .json(createErrorResponse(501, 'Jobs need an SQS queue (not available in memory mode)'));

// POST /v1/fragments/:id/jobs   { "to": ".avif", "width": 800 }
const create = async (req, res) => {
  if (!queue.isEnabled()) return notConfigured(res);

  const { id } = req.params;
  const { to, width } = req.body || {};

  if (typeof to !== 'string' || !extToType[to.toLowerCase()]) {
    return res
      .status(400)
      .json(createErrorResponse(400, `"to" must be one of: ${Object.keys(extToType).join(', ')}`));
  }
  if (width !== undefined && (!Number.isInteger(width) || width < 1 || width > MAX_WIDTH)) {
    return res
      .status(400)
      .json(createErrorResponse(400, `width must be a whole number of pixels (1-${MAX_WIDTH})`));
  }
  const targetType = extToType[to.toLowerCase()];

  let fragment;
  try {
    fragment = await Fragment.byId(req.user, id);
  } catch (err) {
    logger.warn({ err, id }, 'Fragment not found');
    return res.status(404).json(createErrorResponse(404, 'Fragment not found'));
  }

  if (!fragment.formats.includes(targetType)) {
    return res
      .status(415)
      .json(createErrorResponse(415, `Cannot convert ${fragment.type} to ${to.toLowerCase()}`));
  }
  if (width !== undefined && !imageTypes.includes(fragment.mimeType)) {
    return res.status(400).json(createErrorResponse(400, 'width only applies to images'));
  }
  if (targetType === fragment.mimeType && width === undefined) {
    return res
      .status(400)
      .json(createErrorResponse(400, 'Nothing to convert: same type as the fragment, no width'));
  }

  let job;
  try {
    job = await Job.create({
      ownerId: req.user,
      fragmentId: fragment.id,
      to: targetType,
      width,
      requestId: req.id,
    });
  } catch (err) {
    logger.error({ err, id }, 'Error creating job');
    return res.status(500).json(createErrorResponse(500, 'Unable to create job'));
  }

  try {
    await queue.sendJob({ jobId: job.jobId, ownerId: req.user, requestId: req.id });
  } catch (err) {
    // No message means no worker will ever see it: don't leave a job that stays queued for ever
    logger.error({ err, jobId: job.jobId }, 'Error queueing job');
    await Job.remove(req.user, job.jobId).catch((e) =>
      logger.warn({ err: e, jobId: job.jobId }, 'Could not remove job after queueing failed')
    );
    return res.status(503).json(createErrorResponse(503, 'Unable to queue job, try again shortly'));
  }

  logger.info({ jobId: job.jobId, fragmentId: fragment.id, to: targetType }, 'Queued job');
  const baseUrl = process.env.API_URL || `http://${req.headers.host}`;
  res.set('Location', `${baseUrl}/v1/jobs/${job.jobId}`);
  res.status(202).json(createSuccessResponse({ job: await Job.toJSON(job) }));
};

// GET /v1/jobs/:jobId  (only ever your own jobs: someone else's id is a 404)
const get = async (req, res) => {
  try {
    const job = await Job.byId(req.user, req.params.jobId);
    if (!job) return res.status(404).json(createErrorResponse(404, 'Job not found'));
    res.status(200).json(createSuccessResponse({ job: await Job.toJSON(job) }));
  } catch (err) {
    logger.error({ err, jobId: req.params.jobId }, 'Error reading job');
    res.status(500).json(createErrorResponse(500, 'Unable to read job'));
  }
};

module.exports = { create, get };
