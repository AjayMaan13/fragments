const MemoryDB = require('./memory-db');

// Create two in-memory databases: one for fragment metadata and the other for raw data
// The `data` MemoryDB simulates Amazon S3 for blob storage, the `metadata` simulates
// Amazon DynamoDB for key/value storage.
const data = new MemoryDB();
const metadata = new MemoryDB();

// Write a fragment's metadata to memory db. Returns a Promise<void>
function writeFragment(fragment) {
  // Simulate db/network serialization of the value, storing only JSON representation.
  // This is important because it's how things will work later with AWS data stores.
  const serialized = JSON.stringify(fragment);
  return metadata.put(fragment.ownerId, fragment.id, serialized);
}

// Read a fragment's metadata from memory db. Returns a Promise<Object>
async function readFragment(ownerId, id) {
  // NOTE: this data will be raw JSON, we need to turn it back into an Object.
  // You'll need to take care of converting this back into a Fragment instance
  // higher up in the callstack.
  const serialized = await metadata.get(ownerId, id);
  return typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
}

// Write a fragment's data buffer to memory db. Returns a Promise
function writeFragmentData(ownerId, id, buffer) {
  return data.put(ownerId, id, buffer);
}

// Read a fragment's data from memory db. Returns a Promise
function readFragmentData(ownerId, id) {
  return data.get(ownerId, id);
}

// Get a list of fragment ids/objects for the given user from memory db. Returns a Promise
async function listFragments(ownerId, expand = false) {
  const fragments = await metadata.query(ownerId);

  // If we don't get anything back, or are supposed to give expanded fragments, return
  if (expand || !fragments) {
    return fragments;
  }

  // Otherwise, map to only send back the ids
  return fragments.map((fragment) => JSON.parse(fragment).id);
}

// Delete a fragment's metadata and data from memory db. Returns a Promise
function deleteFragment(ownerId, id) {
  return Promise.all([
    // Delete metadata
    metadata.del(ownerId, id),
    // Delete data
    data.del(ownerId, id),
  ]);
}

// Adds one to a fragment's `viewCount`. Returns a Promise<number> with the new count.
async function incrementViews(ownerId, id) {
  const fragment = await readFragment(ownerId, id);
  if (!fragment) {
    throw new Error(`missing entry for ownerId=${ownerId} and id=${id}`);
  }
  fragment.viewCount = (fragment.viewCount || 0) + 1;
  await writeFragment(fragment);
  return fragment.viewCount;
}

// Share links are pre-signed S3 URLs; there's no S3 in memory mode, so there's
// nothing to link to. Returns a Promise<undefined>.
function createShareUrl() {
  return Promise.resolve(undefined);
}

// ---------------------------------------------------------------------------
// Async conversion jobs (same contract as the DynamoDB versions in ../aws).
// ---------------------------------------------------------------------------

const jobs = new MemoryDB();
const results = new MemoryDB();

// DynamoDB checks-and-sets in one atomic step. Here every operation awaits, so
// run the job operations one at a time to get the same guarantee.
let jobQueue = Promise.resolve();
const exclusive = (fn) => {
  const run = jobQueue.then(fn);
  jobQueue = run.catch(() => {});
  return run;
};

const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

function createJob(job) {
  return exclusive(async () => {
    if (await jobs.get(job.ownerId, job.jobId)) throw new Error('job already exists');
    await jobs.put(job.ownerId, job.jobId, clone(job));
  });
}

function readJob(ownerId, jobId) {
  return exclusive(async () => clone(await jobs.get(ownerId, jobId)));
}

function deleteJob(ownerId, jobId) {
  return exclusive(() => jobs.del(ownerId, jobId));
}

function claimJob(ownerId, jobId, nowSeconds, leaseSeconds) {
  return exclusive(async () => {
    const job = await jobs.get(ownerId, jobId);
    const claimable =
      job && (job.status === 'queued' || (job.status === 'running' && job.leaseUntil < nowSeconds));
    if (!claimable) return null;
    job.status = 'running';
    job.attempts = (job.attempts || 0) + 1;
    job.leaseUntil = nowSeconds + leaseSeconds;
    job.updatedAt = new Date(nowSeconds * 1000).toISOString();
    return clone(job);
  });
}

function transitionJob(ownerId, jobId, attempt, status, fields) {
  return exclusive(async () => {
    const job = await jobs.get(ownerId, jobId);
    if (!job || job.status !== 'running' || job.attempts !== attempt) return false;
    Object.assign(job, fields, { status, updatedAt: new Date().toISOString() });
    return true;
  });
}

const finishJob = (ownerId, jobId, attempt, fields) =>
  transitionJob(ownerId, jobId, attempt, 'succeeded', fields);
const failJob = (ownerId, jobId, attempt, error) =>
  transitionJob(ownerId, jobId, attempt, 'failed', { error });
const releaseJob = (ownerId, jobId, attempt, error) =>
  transitionJob(ownerId, jobId, attempt, 'queued', { leaseUntil: 0, lastError: error });

function writeJobResult(ownerId, jobId, buffer) {
  return results.put(ownerId, jobId, buffer);
}

// Test helper: what a worker stored for a job
function readJobResult(ownerId, jobId) {
  return results.get(ownerId, jobId);
}

// No S3 in memory mode, so no download links
function createJobResultUrl() {
  return Promise.resolve(undefined);
}

module.exports.createJob = createJob;
module.exports.readJob = readJob;
module.exports.deleteJob = deleteJob;
module.exports.claimJob = claimJob;
module.exports.finishJob = finishJob;
module.exports.failJob = failJob;
module.exports.releaseJob = releaseJob;
module.exports.writeJobResult = writeJobResult;
module.exports.readJobResult = readJobResult;
module.exports.createJobResultUrl = createJobResultUrl;
module.exports.createShareUrl = createShareUrl;
module.exports.incrementViews = incrementViews;
module.exports.listFragments = listFragments;
module.exports.writeFragment = writeFragment;
module.exports.readFragment = readFragment;
module.exports.writeFragmentData = writeFragmentData;
module.exports.readFragmentData = readFragmentData;
module.exports.deleteFragment = deleteFragment;
