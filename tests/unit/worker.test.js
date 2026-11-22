// tests/unit/worker.test.js

// What the worker does with a queue message, using the in-memory store and a
// fake queue. The behaviours that matter for an at-least-once queue:
// a duplicate message gives one result, a poison message ends in `failed`, and
// a worker that dies is replaced by the redelivered message.

jest.mock('../../src/metrics', () => ({
  ...jest.requireActual('../../src/metrics'),
  recordJob: jest.fn(),
}));
jest.mock('../../src/convert', () => {
  const actual = jest.requireActual('../../src/convert');
  return { ...actual, convertFragment: jest.fn(actual.convertFragment) };
});

const convert = require('../../src/convert');
const { recordJob } = require('../../src/metrics');
const { Fragment } = require('../../src/model/fragment');
const Job = require('../../src/model/job');
const { claimJob, readJob, readJobResult } = require('../../src/model/data');
const { processMessage, retryDelaySeconds } = require('../../src/worker-core');

const owner = 'worker-test-owner';

const fakeQueue = () => ({
  remove: jest.fn().mockResolvedValue(),
  delay: jest.fn().mockResolvedValue(),
});
const message = (job, extra = {}) => ({
  id: 'm1',
  handle: 'h1',
  receiveCount: 1,
  requestId: 'req-1',
  body: JSON.stringify({ jobId: job.jobId, ownerId: owner }),
  ...extra,
});

const makeFragment = async (type, body) => {
  const fragment = new Fragment({ ownerId: owner, type });
  await fragment.save();
  await fragment.setData(Buffer.from(body));
  return fragment;
};
const makeJob = async (fragment, to = 'text/html', extra = {}) =>
  Job.create({ ownerId: owner, fragmentId: fragment.id, to, ...extra });

beforeEach(() => {
  convert.convertFragment.mockClear();
  recordJob.mockClear();
});
afterEach(() => {
  delete process.env.MAX_IMAGE_PIXELS;
});

describe('a successful job', () => {
  test('converts, stores the result, marks it succeeded, and acknowledges the message', async () => {
    const fragment = await makeFragment('text/markdown', '# Title');
    const job = await makeJob(fragment);
    const queue = fakeQueue();

    expect(await processMessage(message(job), { queue })).toBe('succeeded');

    const stored = await readJob(owner, job.jobId);
    expect(stored).toMatchObject({ status: 'succeeded', attempts: 1, leaseUntil: 0 });
    expect(stored.resultSize).toBe((await readJobResult(owner, job.jobId)).length);
    expect((await readJobResult(owner, job.jobId)).toString()).toContain('<h1>Title</h1>');
    expect(queue.remove).toHaveBeenCalledWith('h1');
    expect(queue.delay).not.toHaveBeenCalled();
  });

  test('records the job metrics with the target type', async () => {
    const job = await makeJob(await makeFragment('text/markdown', '# x'));
    await processMessage(message(job), { queue: fakeQueue() });
    expect(recordJob).toHaveBeenCalledTimes(1);
    const [type, processingMs, endToEndMs] = recordJob.mock.calls[0];
    expect(type).toBe('text/html');
    expect(processingMs).toBeGreaterThanOrEqual(0);
    expect(endToEndMs).toBeGreaterThanOrEqual(0);
  });

  test('passes the requested width through to the conversion', async () => {
    const sharp = require('sharp');
    const png = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#f00' } })
      .png()
      .toBuffer();
    const fragment = new Fragment({ ownerId: owner, type: 'image/png' });
    await fragment.save();
    await fragment.setData(png);
    const job = await makeJob(fragment, 'image/webp', { width: 10 });

    expect(await processMessage(message(job), { queue: fakeQueue() })).toBe('succeeded');
    const meta = await sharp(await readJobResult(owner, job.jobId)).metadata();
    expect([meta.format, meta.width]).toEqual(['webp', 10]);
  });
});

describe('the same message delivered twice (at-least-once delivery)', () => {
  test('the second delivery is dropped: one conversion, one result, message acknowledged both times', async () => {
    const job = await makeJob(await makeFragment('text/markdown', '# once'));
    const queue = fakeQueue();

    expect(await processMessage(message(job), { queue })).toBe('succeeded');
    const firstResult = await readJobResult(owner, job.jobId);
    expect(await processMessage(message(job, { receiveCount: 2 }), { queue })).toBe('skipped');

    expect(convert.convertFragment).toHaveBeenCalledTimes(1);
    expect(await readJobResult(owner, job.jobId)).toBe(firstResult);
    expect((await readJob(owner, job.jobId)).attempts).toBe(1);
    expect(queue.remove).toHaveBeenCalledTimes(2);
  });

  test('two workers receiving it at the same moment: one converts, the other backs off', async () => {
    const job = await makeJob(await makeFragment('text/markdown', '# race'));
    const queueA = fakeQueue();
    const queueB = fakeQueue();

    const outcomes = await Promise.all([
      processMessage(message(job), { queue: queueA }),
      processMessage(message(job), { queue: queueB }),
    ]);

    expect([...outcomes].sort()).toEqual(['leased', 'succeeded']);
    expect(convert.convertFragment).toHaveBeenCalledTimes(1);
    // the loser did not delete the message (the winner might still fail) but asked to look again later
    const loser = outcomes[0] === 'leased' ? queueA : queueB;
    expect(loser.remove).not.toHaveBeenCalled();
    expect(loser.delay).toHaveBeenCalledWith('h1', expect.any(Number));
    expect(loser.delay.mock.calls[0][1]).toBeGreaterThanOrEqual(1);
  });

  test('a message for a job that no longer exists is dropped', async () => {
    const queue = fakeQueue();
    const ghost = { jobId: 'gone', ownerId: owner };
    expect(await processMessage(message(ghost), { queue })).toBe('skipped');
    expect(queue.remove).toHaveBeenCalled();
  });
});

describe('a worker that dies mid-job', () => {
  test('the redelivered message completes the job once the lease has run out', async () => {
    const job = await makeJob(await makeFragment('text/markdown', '# recovered'));
    // Worker 1 claimed it a long time ago and was then killed: status running, lease long expired
    await claimJob(owner, job.jobId, Job.nowSeconds() - 1000, 100);

    expect(await processMessage(message(job, { receiveCount: 2 }), { queue: fakeQueue() })).toBe(
      'succeeded'
    );

    expect(await readJob(owner, job.jobId)).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect((await readJobResult(owner, job.jobId)).toString()).toContain('recovered');
    expect(convert.convertFragment).toHaveBeenCalledTimes(1);
  });

  test('a message that arrives while the first worker is still within its lease is left alone', async () => {
    const job = await makeJob(await makeFragment('text/markdown', '# busy'));
    await claimJob(owner, job.jobId, Job.nowSeconds(), 100);
    const queue = fakeQueue();

    expect(await processMessage(message(job), { queue })).toBe('leased');
    expect(convert.convertFragment).not.toHaveBeenCalled();
    expect(queue.remove).not.toHaveBeenCalled();
    expect(queue.delay.mock.calls[0][1]).toBeGreaterThan(1);
  });

  test('a worker that finishes after losing its lease is told so, and does not overwrite the new owner', async () => {
    const job = await makeJob(await makeFragment('text/markdown', '# slow'));
    // While worker 1 converts, its lease expires and worker 2 takes the job
    convert.convertFragment.mockImplementationOnce(async (...args) => {
      await claimJob(owner, job.jobId, Job.nowSeconds() + 1000, 100);
      return jest.requireActual('../../src/convert').convertFragment(...args);
    });

    expect(await processMessage(message(job), { queue: fakeQueue() })).toBe('superseded');
    // worker 2's claim stands: still running, not marked succeeded by worker 1
    expect(await readJob(owner, job.jobId)).toMatchObject({ status: 'running', attempts: 2 });
    expect(recordJob).not.toHaveBeenCalled();
  });
});

describe('failures', () => {
  test('a poison message is retried, then ends in `failed` on the last attempt', async () => {
    // JSON that is not JSON: converting to YAML throws every time
    const fragment = await makeFragment('application/json', '{not json');
    const job = await makeJob(fragment, 'application/yaml');
    const queue = fakeQueue();

    expect(await processMessage(message(job, { receiveCount: 1 }), { queue })).toBe('retry');
    expect(await readJob(owner, job.jobId)).toMatchObject({ status: 'queued', attempts: 1 });
    expect(queue.delay).toHaveBeenLastCalledWith('h1', 10);
    expect(queue.remove).not.toHaveBeenCalled();

    expect(await processMessage(message(job, { receiveCount: 2 }), { queue })).toBe('retry');
    expect(queue.delay).toHaveBeenLastCalledWith('h1', 20);

    expect(await processMessage(message(job, { receiveCount: 3 }), { queue })).toBe('failed');
    const stored = await readJob(owner, job.jobId);
    expect(stored).toMatchObject({ status: 'failed', attempts: 3 });
    expect(stored.error).toBeTruthy();
    expect(queue.remove).toHaveBeenCalledTimes(1);
    // ...and a stray fourth delivery changes nothing
    expect(await processMessage(message(job, { receiveCount: 4 }), { queue })).toBe('skipped');
  });

  test('a fragment that was deleted fails the job straight away (retrying cannot help)', async () => {
    const fragment = await makeFragment('text/markdown', '# bye');
    const job = await makeJob(fragment);
    await Fragment.delete(owner, fragment.id);
    const queue = fakeQueue();

    expect(await processMessage(message(job), { queue })).toBe('failed');
    expect(await readJob(owner, job.jobId)).toMatchObject({
      status: 'failed',
      error: 'Fragment not found (deleted or expired)',
    });
    expect(queue.remove).toHaveBeenCalled();
  });

  test('an expired fragment is treated as deleted', async () => {
    const fragment = new Fragment({
      ownerId: owner,
      type: 'text/markdown',
      expiresAt: Math.floor(Date.now() / 1000) - 10,
    });
    await fragment.save();
    await fragment.setData(Buffer.from('# old'));
    const job = await makeJob(fragment);
    expect(await processMessage(message(job), { queue: fakeQueue() })).toBe('failed');
  });

  test('a conversion with no implementation fails permanently', async () => {
    const job = await makeJob(await makeFragment('text/plain', 'x'), 'image/png');
    expect(await processMessage(message(job), { queue: fakeQueue() })).toBe('failed');
    expect((await readJob(owner, job.jobId)).error).toContain('Cannot convert');
  });

  test('an image over the pixel limit fails permanently with the reason, no retries', async () => {
    const sharp = require('sharp');
    process.env.MAX_IMAGE_PIXELS = '100';
    const png = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#0f0' } })
      .png()
      .toBuffer();
    const fragment = new Fragment({ ownerId: owner, type: 'image/png' });
    await fragment.save();
    await fragment.setData(png);
    const job = await makeJob(fragment, 'image/webp');
    const queue = fakeQueue();

    expect(await processMessage(message(job), { queue })).toBe('failed');
    expect((await readJob(owner, job.jobId)).error).toContain('too large');
    expect((await readJob(owner, job.jobId)).attempts).toBe(1);
    expect(queue.delay).not.toHaveBeenCalled();
  });

  test('a busy converter (503) is retried, not failed', async () => {
    const job = await makeJob(await makeFragment('text/markdown', '# busy'));
    convert.convertFragment.mockRejectedValueOnce(
      new convert.ConversionLimitError('Busy converting other images', 503, 5)
    );
    const queue = fakeQueue();
    expect(await processMessage(message(job), { queue })).toBe('retry');
    expect((await readJob(owner, job.jobId)).status).toBe('queued');
    expect(queue.delay).toHaveBeenCalled();
  });

  test('a malformed message is discarded', async () => {
    const queue = fakeQueue();
    for (const body of ['not json', '{}', JSON.stringify({ jobId: 'x' })]) {
      expect(await processMessage({ id: 'm', handle: 'h', receiveCount: 1, body }, { queue })).toBe(
        'discarded'
      );
    }
    expect(queue.remove).toHaveBeenCalledTimes(3);
  });
});

describe('retryDelaySeconds', () => {
  test('doubles from 10 s and is capped at a minute', () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelaySeconds)).toEqual([10, 20, 40, 60, 60, 60]);
  });
});

// ---------------------------------------------------------------------------
// Retry versus fail, and the numbers the worker reports. Gaps found by
// mutation testing (docs/mutation/).
// ---------------------------------------------------------------------------

describe('when a failed attempt is the last one', () => {
  const poison = async () =>
    makeJob(await makeFragment('application/json', '{not json'), 'application/yaml');

  test('the queue has delivered it the maximum number of times, even if the job has been claimed fewer', async () => {
    const job = await poison();
    const queue = fakeQueue();
    expect(await processMessage(message(job, { receiveCount: Job.maxAttempts() }), { queue })).toBe(
      'failed'
    );
    expect((await readJob(owner, job.jobId)).attempts).toBe(1);
  });

  test('the job has been claimed the maximum number of times, even if the queue shows fewer deliveries', async () => {
    const job = await poison();
    // two earlier workers claimed it and vanished
    await claimJob(owner, job.jobId, Job.nowSeconds() - 1000, 10);
    await claimJob(owner, job.jobId, Job.nowSeconds() - 500, 10);

    expect(await processMessage(message(job, { receiveCount: 1 }), { queue: fakeQueue() })).toBe(
      'failed'
    );
    expect((await readJob(owner, job.jobId)).attempts).toBe(Job.maxAttempts());
  });

  test('one attempt short of the maximum on both counts is still retried', async () => {
    const job = await poison();
    expect(
      await processMessage(message(job, { receiveCount: Job.maxAttempts() - 1 }), {
        queue: fakeQueue(),
      })
    ).toBe('retry');
  });
});

describe('what counts as "fragment not found"', () => {
  const { Fragment: F } = require('../../src/model/fragment');
  afterEach(() => jest.restoreAllMocks());

  test("only the model's own message is permanent; the same words buried in another error are retried", async () => {
    const job = await makeJob(await makeFragment('text/markdown', '# x'));
    jest.spyOn(F, 'byId').mockRejectedValueOnce(new Error('upstream said: fragment not found'));
    expect(await processMessage(message(job), { queue: fakeQueue() })).toBe('retry');
  });

  test('a database outage is retried', async () => {
    const job = await makeJob(await makeFragment('text/markdown', '# x'));
    jest.spyOn(F, 'byId').mockRejectedValueOnce(new Error('connect ECONNRESET'));
    expect(await processMessage(message(job), { queue: fakeQueue() })).toBe('retry');
  });

  test("the model's message, as it is really worded, is permanent", async () => {
    const job = await makeJob(await makeFragment('text/markdown', '# x'));
    jest.spyOn(F, 'byId').mockRejectedValueOnce(new Error('fragment not found: abc'));
    expect(await processMessage(message(job), { queue: fakeQueue() })).toBe('failed');
  });
});

describe('the numbers it reports', () => {
  afterEach(() => jest.restoreAllMocks());

  test('processing time is in milliseconds and plausible for a tiny conversion', async () => {
    const job = await makeJob(await makeFragment('text/markdown', '# fast'));
    await processMessage(message(job), { queue: fakeQueue() });
    const stored = await readJob(owner, job.jobId);
    expect(Number.isInteger(stored.durationMs)).toBe(true);
    expect(stored.durationMs).toBeGreaterThanOrEqual(0);
    expect(stored.durationMs).toBeLessThan(2000);
    const [, processingMs] = recordJob.mock.calls[0];
    expect(processingMs).toBeLessThan(2000);
  });

  test('end-to-end time is how long ago the job was created', async () => {
    const job = await makeJob(await makeFragment('text/markdown', '# slow queue'));
    const created = Date.parse(job.createdAt);
    jest.spyOn(Date, 'now').mockReturnValue(created + 7500);
    await processMessage(message(job), { queue: fakeQueue() });
    expect(recordJob.mock.calls[0][2]).toBe(7500);
  });

  test('end-to-end time is never negative, even if clocks disagree', async () => {
    const job = await makeJob(await makeFragment('text/markdown', '# clocks'));
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(job.createdAt) - 5000);
    await processMessage(message(job), { queue: fakeQueue() });
    expect(recordJob.mock.calls[0][2]).toBe(0);
  });

  test('a job held by another worker is looked at again when that lease ends, not before or long after', async () => {
    const job = await makeJob(await makeFragment('text/markdown', '# held'));
    const now = Job.nowSeconds();
    await claimJob(owner, job.jobId, now, 100);
    const queue = fakeQueue();
    await processMessage(message(job), { queue });
    const [, wait] = queue.delay.mock.calls[0];
    expect(wait).toBeGreaterThanOrEqual(99);
    expect(wait).toBeLessThanOrEqual(100);
  });
});
