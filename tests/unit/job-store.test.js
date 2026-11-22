// tests/unit/job-store.test.js

// The job state machine on the in-memory store. The DynamoDB store implements
// the same contract with conditional updates, so these are the rules both follow.

const Job = require('../../src/model/job');
const { claimJob, readJob, finishJob, failJob, releaseJob } = require('../../src/model/data');

const owner = 'owner-1';
const fresh = (overrides = {}) =>
  Job.create({ ownerId: owner, fragmentId: 'frag-1', to: 'text/html', ...overrides });

const NOW = 1_000_000;
const LEASE = 100;

describe('Job.create / byId', () => {
  test('a new job is queued, has no attempts, and expires in a day', async () => {
    const job = await fresh({ width: 200, requestId: 'req-1' });
    expect(job).toMatchObject({
      ownerId: owner,
      fragmentId: 'frag-1',
      to: 'text/html',
      status: 'queued',
      attempts: 0,
      width: 200,
      requestId: 'req-1',
    });
    expect(job.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(job.expiresAt - Math.floor(Date.parse(job.createdAt) / 1000)).toBe(24 * 60 * 60);
  });

  test('optional fields are left out when not given (DynamoDB rejects undefined)', async () => {
    const job = await fresh();
    expect(job).not.toHaveProperty('width');
    expect(job).not.toHaveProperty('requestId');
  });

  test("a job is only visible to its owner: another owner's id looks like a missing job", async () => {
    const job = await fresh();
    expect(await Job.byId(owner, job.jobId)).toBeDefined();
    expect(await Job.byId('someone-else', job.jobId)).toBeUndefined();
  });
});

describe('claimJob', () => {
  test('queued -> running, counts the attempt and sets a lease', async () => {
    const job = await fresh();
    const claimed = await claimJob(owner, job.jobId, NOW, LEASE);
    expect(claimed).toMatchObject({ status: 'running', attempts: 1, leaseUntil: NOW + LEASE });
  });

  test('cannot be claimed while another worker holds a live lease', async () => {
    const job = await fresh();
    await claimJob(owner, job.jobId, NOW, LEASE);
    expect(await claimJob(owner, job.jobId, NOW + LEASE - 1, LEASE)).toBeNull();
  });

  test('can be claimed again once the lease has run out (the worker died)', async () => {
    const job = await fresh();
    await claimJob(owner, job.jobId, NOW, LEASE);
    const second = await claimJob(owner, job.jobId, NOW + LEASE + 1, LEASE);
    expect(second).toMatchObject({ status: 'running', attempts: 2 });
  });

  test('a missing job cannot be claimed', async () => {
    expect(await claimJob(owner, 'no-such-job', NOW, LEASE)).toBeNull();
  });

  test('finished jobs (succeeded or failed) are never claimed again', async () => {
    const done = await fresh();
    const a = await claimJob(owner, done.jobId, NOW, LEASE);
    await finishJob(owner, done.jobId, a.attempts, { resultSize: 1 });
    expect(await claimJob(owner, done.jobId, NOW + 10_000, LEASE)).toBeNull();

    const failed = await fresh();
    const b = await claimJob(owner, failed.jobId, NOW, LEASE);
    await failJob(owner, failed.jobId, b.attempts, 'boom');
    expect(await claimJob(owner, failed.jobId, NOW + 10_000, LEASE)).toBeNull();
  });

  test('of many simultaneous claims, exactly one wins', async () => {
    const job = await fresh();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimJob(owner, job.jobId, NOW, LEASE))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await readJob(owner, job.jobId)).attempts).toBe(1);
  });
});

describe('finishJob / failJob / releaseJob', () => {
  test('finish records the result fields and marks it succeeded', async () => {
    const job = await fresh();
    const { attempts } = await claimJob(owner, job.jobId, NOW, LEASE);
    expect(await finishJob(owner, job.jobId, attempts, { resultSize: 42 })).toBe(true);
    expect(await readJob(owner, job.jobId)).toMatchObject({ status: 'succeeded', resultSize: 42 });
  });

  test('a worker that lost its lease cannot overwrite the one that took over', async () => {
    const job = await fresh();
    const first = await claimJob(owner, job.jobId, NOW, LEASE); // attempt 1, then it stalls
    const second = await claimJob(owner, job.jobId, NOW + LEASE + 1, LEASE); // attempt 2

    expect(await finishJob(owner, job.jobId, first.attempts, { resultSize: 1 })).toBe(false);
    expect(await failJob(owner, job.jobId, first.attempts, 'late')).toBe(false);
    expect((await readJob(owner, job.jobId)).status).toBe('running');

    expect(await finishJob(owner, job.jobId, second.attempts, { resultSize: 2 })).toBe(true);
    expect((await readJob(owner, job.jobId)).resultSize).toBe(2);
  });

  test('a job that is not running cannot be finished, failed or released', async () => {
    const job = await fresh();
    expect(await finishJob(owner, job.jobId, 1, {})).toBe(false);
    expect(await failJob(owner, job.jobId, 1, 'x')).toBe(false);
    expect(await releaseJob(owner, job.jobId, 1, 'x')).toBe(false);
    expect(await finishJob(owner, 'no-such-job', 1, {})).toBe(false);
  });

  test('fail stores the error', async () => {
    const job = await fresh();
    const { attempts } = await claimJob(owner, job.jobId, NOW, LEASE);
    await failJob(owner, job.jobId, attempts, 'unsupported');
    expect(await readJob(owner, job.jobId)).toMatchObject({
      status: 'failed',
      error: 'unsupported',
    });
  });

  test('release puts it back to queued with no lease, so it can be claimed straight away', async () => {
    const job = await fresh();
    const { attempts } = await claimJob(owner, job.jobId, NOW, LEASE);
    expect(await releaseJob(owner, job.jobId, attempts, 'transient')).toBe(true);
    expect(await readJob(owner, job.jobId)).toMatchObject({
      status: 'queued',
      leaseUntil: 0,
      lastError: 'transient',
    });
    expect(await claimJob(owner, job.jobId, NOW + 1, LEASE)).toMatchObject({ attempts: 2 });
  });
});

describe('Job.effectiveStatus', () => {
  const job = (o) => ({ status: 'running', attempts: 1, leaseUntil: NOW + 10, ...o });

  test('a normal running job is running', () => {
    expect(Job.effectiveStatus(job(), NOW).status).toBe('running');
  });

  test('a job whose worker died on the last allowed attempt is reported failed, not running forever', () => {
    const stuck = job({ attempts: Job.maxAttempts(), leaseUntil: NOW - 1 });
    expect(Job.effectiveStatus(stuck, NOW)).toEqual({
      status: 'failed',
      error: `worker did not finish after ${Job.maxAttempts()} attempts`,
    });
  });

  test('but not while that last attempt could still be running', () => {
    const live = job({ attempts: Job.maxAttempts(), leaseUntil: NOW + 5 });
    expect(Job.effectiveStatus(live, NOW).status).toBe('running');
  });

  test('and not if it still has attempts left (the message will be redelivered)', () => {
    expect(Job.effectiveStatus(job({ attempts: 1, leaseUntil: NOW - 1 }), NOW).status).toBe(
      'running'
    );
  });

  test('finished statuses pass through, with their error', () => {
    expect(Job.effectiveStatus(job({ status: 'failed', error: 'e' }), NOW)).toEqual({
      status: 'failed',
      error: 'e',
    });
    expect(Job.effectiveStatus(job({ status: 'succeeded' }), NOW).status).toBe('succeeded');
  });
});

describe('Job.toJSON', () => {
  test('hides internals and shows only what a client needs', async () => {
    const job = await fresh({ width: 10, requestId: 'r' });
    const view = await Job.toJSON(job);
    expect(view).toEqual({
      id: job.jobId,
      fragmentId: 'frag-1',
      to: 'text/html',
      status: 'queued',
      attempts: 0,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      width: 10,
      requestId: 'r',
    });
    expect(view).not.toHaveProperty('ownerId');
    expect(view).not.toHaveProperty('leaseUntil');
  });

  test('a succeeded job reports its result (no link in memory mode)', async () => {
    const job = { ...(await fresh()), status: 'succeeded', resultSize: 7 };
    expect((await Job.toJSON(job)).result).toEqual({ type: 'text/html', size: 7 });
  });
});
