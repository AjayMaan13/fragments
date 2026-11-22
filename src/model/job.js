// src/model/job.js

// An asynchronous conversion job: "convert fragment X to type Y". The API
// records it and queues a message; a worker does the (slow) conversion later.
//
// Lifecycle:   queued -> running -> succeeded | failed
//                  ^________|  (released after a retryable error)
//
// A running job carries a lease (`leaseUntil`). A worker that dies mid-job
// stops renewing nothing: the lease simply runs out, and the redelivered queue
// message can claim the job again. Finished jobs are never claimed twice, so a
// duplicate delivery produces no second result.

const { randomUUID } = require('crypto');

const { createJob, readJob, deleteJob, createJobResultUrl } = require('./data');

const STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
});

// Must match the queue's maxReceiveCount (infra/modules/queue): after this many
// deliveries SQS moves the message to the dead-letter queue.
const maxAttempts = () => Number(process.env.JOB_MAX_ATTEMPTS) || 3;
// How long a worker may hold a job. Keep it a little under the queue's
// visibility timeout so the lease is over by the time the message is redelivered.
const leaseSeconds = () => Number(process.env.JOB_LEASE_SECONDS) || 110;
// Job records (and, via an S3 lifecycle rule, their results) are kept for a day
const JOB_TTL_SECONDS = 24 * 60 * 60;
const MAX_RESULT_URL_SECONDS = 60 * 60;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Creates and stores a new job in the `queued` state.
 * @param {{ownerId: string, fragmentId: string, to: string, width?: number, requestId?: string}} input
 * @returns Promise<object> the stored job
 */
async function create({ ownerId, fragmentId, to, width, requestId }) {
  const now = new Date();
  const job = {
    ownerId,
    jobId: randomUUID(),
    fragmentId,
    to, // the target MIME type, e.g. 'image/avif'
    status: STATUS.QUEUED,
    attempts: 0,
    leaseUntil: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    // DynamoDB TTL (Unix seconds) cleans old records up on its own
    expiresAt: Math.floor(now.getTime() / 1000) + JOB_TTL_SECONDS,
  };
  // DynamoDB rejects undefined values, so only add the optional fields that exist
  if (width !== undefined) job.width = width;
  if (requestId) job.requestId = requestId;
  await createJob(job);
  return job;
}

/**
 * Reads a job owned by `ownerId`. Resolves to undefined when there is no such
 * job for that owner: someone else's job id looks exactly like a missing one.
 */
const byId = (ownerId, jobId) => readJob(ownerId, jobId);

// Used when queueing failed after the record was written
const remove = (ownerId, jobId) => deleteJob(ownerId, jobId);

/**
 * The status to show a client. A job whose worker died on its last allowed
 * attempt stays `running` forever in the table (the queue has already moved
 * the message to the dead-letter queue and no one will touch it again), so
 * report that as failed instead of "running" for ever.
 */
function effectiveStatus(job, now = nowSeconds()) {
  if (job.status === STATUS.RUNNING && job.attempts >= maxAttempts() && job.leaseUntil < now) {
    return { status: STATUS.FAILED, error: `worker did not finish after ${job.attempts} attempts` };
  }
  return { status: job.status, error: job.error || job.lastError };
}

/**
 * The job as the API shows it. Includes a temporary download link once it has
 * succeeded (S3 mode only).
 */
async function toJSON(job, now = nowSeconds()) {
  const { status, error } = effectiveStatus(job, now);
  const view = {
    id: job.jobId,
    fragmentId: job.fragmentId,
    to: job.to,
    status,
    attempts: job.attempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  if (job.width !== undefined) view.width = job.width;
  if (job.requestId) view.requestId = job.requestId;
  if (status === STATUS.FAILED && error) view.error = error;

  if (status === STATUS.SUCCEEDED) {
    const remaining = job.expiresAt - now;
    const expiresIn = Math.max(1, Math.min(MAX_RESULT_URL_SECONDS, remaining));
    // Never serve user-supplied HTML as a live page from the storage domain
    const contentType = job.to === 'text/html' ? 'text/plain' : job.to;
    const url = await createJobResultUrl(job.ownerId, job.jobId, expiresIn, contentType);
    view.result = { type: job.to, size: job.resultSize };
    if (url) Object.assign(view.result, { url, expiresIn });
  }
  return view;
}

module.exports = {
  STATUS,
  create,
  byId,
  remove,
  effectiveStatus,
  toJSON,
  maxAttempts,
  leaseSeconds,
  nowSeconds,
};
