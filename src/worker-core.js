// src/worker-core.js

// What the worker does with one queue message. Kept apart from the polling loop
// (worker.js) so it can be tested with a fake queue and the in-memory store.
//
// Delivery is "at least once", so the same job can arrive twice. This stays
// correct because every state change is a conditional update (see the job
// store): a finished job can't be claimed again, and a worker that lost its
// lease can't overwrite the one that took over.
//
// Returns what happened, mostly so tests (and logs) can say it:
//   'succeeded'  converted, stored, message deleted
//   'superseded' converted, but another worker had taken the job over; our result is dropped
//   'failed'     gave up (permanent error or last attempt), message deleted
//   'retry'      transient error, job released, message redelivered later
//   'skipped'    nothing to do (job finished or gone), message deleted
//   'leased'     another worker holds the job; message left for redelivery
//   'discarded'  malformed message, deleted

const baseLogger = require('./logger');
const { Fragment } = require('./model/fragment');
const Job = require('./model/job');
const {
  claimJob,
  readJob,
  finishJob,
  failJob,
  releaseJob,
  writeJobResult,
} = require('./model/data');
const { convertFragment, ConversionLimitError } = require('./convert');
const { recordJob } = require('./metrics');

// A failure retrying cannot fix
class PermanentJobError extends Error {}

const isPermanent = (err) =>
  err instanceof PermanentJobError || (err instanceof ConversionLimitError && err.status === 422);

// Wait before a retry: 10 s, 20 s, 40 s, ... capped at a minute
const retryDelaySeconds = (receiveCount) => Math.min(60, 10 * 2 ** (receiveCount - 1));

async function processMessage(message, { queue = require('./queue') } = {}) {
  let body;
  try {
    body = JSON.parse(message.body);
    if (!body.jobId || !body.ownerId) throw new Error('missing jobId/ownerId');
  } catch (err) {
    baseLogger.warn({ err, messageId: message.id }, 'Discarding malformed job message');
    await queue.remove(message.handle);
    return 'discarded';
  }

  const { jobId, ownerId } = body;
  const log = baseLogger.child({ jobId, requestId: message.requestId });
  const now = Job.nowSeconds();

  const job = await claimJob(ownerId, jobId, now, Job.leaseSeconds());
  if (!job) {
    const existing = await readJob(ownerId, jobId);
    if (
      !existing ||
      existing.status === Job.STATUS.SUCCEEDED ||
      existing.status === Job.STATUS.FAILED
    ) {
      log.info({ status: existing?.status }, 'Job already finished or gone, dropping message');
      await queue.remove(message.handle);
      return 'skipped';
    }
    // Someone else is working on it. Leave the message; look again when their lease ends.
    const wait = Math.max(1, existing.leaseUntil - now);
    log.info({ wait }, 'Job is being processed by another worker, will look again later');
    await queue.delay(message.handle, wait);
    return 'leased';
  }

  const attempt = job.attempts;
  const started = process.hrtime.bigint();
  log.info({ attempt, to: job.to, width: job.width }, 'Processing job');

  try {
    let fragment;
    try {
      fragment = await Fragment.byId(ownerId, job.fragmentId);
    } catch (err) {
      // Deleted or expired: retrying can't bring it back. Anything else (say, the
      // database being unreachable) is worth another attempt.
      if (/^fragment not found/.test(err.message)) {
        throw new PermanentJobError('Fragment not found (deleted or expired)');
      }
      throw err;
    }
    const data = await fragment.getData();

    const converted = await convertFragment(data, fragment.mimeType, job.to, { width: job.width });
    if (converted === undefined) {
      throw new PermanentJobError(`Cannot convert ${fragment.type} to ${job.to}`);
    }
    const result = Buffer.isBuffer(converted) ? converted : Buffer.from(converted);

    await writeJobResult(ownerId, jobId, result, job.to);
    const processingMs = Number(process.hrtime.bigint() - started) / 1e6;
    const owns = await finishJob(ownerId, jobId, attempt, {
      resultSize: result.length,
      durationMs: Math.round(processingMs),
      leaseUntil: 0,
    });

    if (owns) {
      recordJob(
        job.to,
        Math.round(processingMs),
        Math.max(0, Date.now() - Date.parse(job.createdAt))
      );
      log.info({ size: result.length, processingMs: Math.round(processingMs) }, 'Job succeeded');
    } else {
      log.warn('Lost the job lease before finishing; another worker took over');
    }
    await queue.remove(message.handle);
    return owns ? 'succeeded' : 'superseded';
  } catch (err) {
    const lastAttempt = message.receiveCount >= Job.maxAttempts() || attempt >= Job.maxAttempts();
    if (isPermanent(err) || lastAttempt) {
      await failJob(ownerId, jobId, attempt, err.message);
      log.warn({ err, attempt, permanent: isPermanent(err) }, 'Job failed');
      await queue.remove(message.handle);
      return 'failed';
    }

    // Give the job back and let the queue redeliver it after a pause
    await releaseJob(ownerId, jobId, attempt, err.message);
    const wait = retryDelaySeconds(message.receiveCount);
    log.warn({ err, attempt, retryInSeconds: wait }, 'Job attempt failed, will retry');
    await queue.delay(message.handle, wait);
    return 'retry';
  }
}

module.exports = { processMessage, PermanentJobError, retryDelaySeconds };
