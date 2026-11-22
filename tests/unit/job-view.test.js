// tests/unit/job-view.test.js

// How a job is shown to a client, and the numbers behind it: the lifetime of the
// result link, which content type it is served as, when a stuck job is reported
// failed. Gaps found by mutation testing (docs/mutation/).

jest.mock('../../src/model/data/memory', () => ({
  ...jest.requireActual('../../src/model/data/memory'),
  createJobResultUrl: jest.fn(),
}));

const { createJobResultUrl } = require('../../src/model/data/memory');
const Job = require('../../src/model/job');

const NOW = 1_800_000_000;
const succeeded = (overrides = {}) => ({
  ownerId: 'o1',
  jobId: 'j1',
  fragmentId: 'f1',
  to: 'image/avif',
  status: 'succeeded',
  attempts: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:05.000Z',
  expiresAt: NOW + 24 * 3600,
  resultSize: 123,
  ...overrides,
});

beforeEach(() => {
  createJobResultUrl.mockReset();
  createJobResultUrl.mockResolvedValue('https://s3.example/result?sig=1');
});

describe('the result link', () => {
  test('lasts an hour at most, even when the job record will live a day', async () => {
    const view = await Job.toJSON(succeeded(), NOW);
    expect(createJobResultUrl).toHaveBeenCalledWith('o1', 'j1', 3600, 'image/avif');
    expect(view.result).toEqual({
      type: 'image/avif',
      size: 123,
      url: 'https://s3.example/result?sig=1',
      expiresIn: 3600,
    });
  });

  test('never outlives the job record: a shorter remaining life wins', async () => {
    const view = await Job.toJSON(succeeded({ expiresAt: NOW + 90 }), NOW);
    expect(createJobResultUrl).toHaveBeenCalledWith('o1', 'j1', 90, 'image/avif');
    expect(view.result.expiresIn).toBe(90);
  });

  test('an already-expired record still gets a valid (one second) lifetime, never zero or negative', async () => {
    await Job.toJSON(succeeded({ expiresAt: NOW - 500 }), NOW);
    expect(createJobResultUrl.mock.calls[0][2]).toBe(1);
  });

  test('without S3 (memory mode) there is a result but no link', async () => {
    createJobResultUrl.mockResolvedValue(undefined);
    const view = await Job.toJSON(succeeded(), NOW);
    expect(view.result).toEqual({ type: 'image/avif', size: 123 });
  });

  test('HTML results are served as plain text, so stored user HTML never runs as a page', async () => {
    await Job.toJSON(succeeded({ to: 'text/html' }), NOW);
    expect(createJobResultUrl.mock.calls[0][3]).toBe('text/plain');
    await Job.toJSON(succeeded({ to: 'application/json' }), NOW);
    expect(createJobResultUrl.mock.calls[1][3]).toBe('application/json');
  });

  test('is only made for succeeded jobs', async () => {
    for (const status of ['queued', 'running', 'failed']) {
      await Job.toJSON(succeeded({ status, leaseUntil: NOW + 50 }), NOW);
    }
    expect(createJobResultUrl).not.toHaveBeenCalled();
  });
});

describe('what is shown', () => {
  test('optional fields appear only when the job has them', async () => {
    const bare = await Job.toJSON(succeeded({ status: 'queued' }), NOW);
    expect(bare).not.toHaveProperty('width');
    expect(bare).not.toHaveProperty('requestId');
    expect(bare).not.toHaveProperty('error');
    expect(bare).not.toHaveProperty('result');

    const full = await Job.toJSON(
      succeeded({ status: 'queued', width: 300, requestId: 'r-1' }),
      NOW
    );
    expect(full).toMatchObject({ width: 300, requestId: 'r-1' });
  });

  test('a failed job shows its error; failing without a recorded error shows none', async () => {
    expect((await Job.toJSON(succeeded({ status: 'failed', error: 'too large' }), NOW)).error).toBe(
      'too large'
    );
    expect(await Job.toJSON(succeeded({ status: 'failed' }), NOW)).not.toHaveProperty('error');
  });

  test('a job that is retrying does not show the last error (it is not failed yet)', async () => {
    const view = await Job.toJSON(succeeded({ status: 'queued', lastError: 'transient' }), NOW);
    expect(view).not.toHaveProperty('error');
  });

  test('a succeeded job never shows an error, even if an earlier attempt left one', async () => {
    const view = await Job.toJSON(succeeded({ lastError: 'earlier attempt failed' }), NOW);
    expect(view).not.toHaveProperty('error');
  });
});

describe('effectiveStatus', () => {
  const stuck = (leaseUntil) => ({ status: 'running', attempts: Job.maxAttempts(), leaseUntil });

  test('a last-attempt job is reported failed only once its lease has strictly run out', () => {
    expect(Job.effectiveStatus(stuck(NOW), NOW).status).toBe('running'); // lease ends this very second
    expect(Job.effectiveStatus(stuck(NOW - 1), NOW).status).toBe('failed');
  });

  test('a job that succeeded on its last attempt is succeeded, not "worker did not finish"', () => {
    const done = { status: 'succeeded', attempts: Job.maxAttempts(), leaseUntil: 0 };
    expect(Job.effectiveStatus(done, NOW).status).toBe('succeeded');
    const failed = {
      status: 'failed',
      attempts: Job.maxAttempts(),
      leaseUntil: 0,
      error: 'real error',
    };
    expect(Job.effectiveStatus(failed, NOW)).toEqual({ status: 'failed', error: 'real error' });
  });

  test('a queued job is queued, however many attempts it has had', () => {
    const waiting = { status: 'queued', attempts: Job.maxAttempts(), leaseUntil: 0 };
    expect(Job.effectiveStatus(waiting, NOW).status).toBe('queued');
  });

  test('falls back to the last error when there is no final error', () => {
    expect(
      Job.effectiveStatus({ status: 'queued', attempts: 1, lastError: 'earlier' }, NOW).error
    ).toBe('earlier');
    expect(
      Job.effectiveStatus(
        { status: 'failed', attempts: 1, error: 'final', lastError: 'earlier' },
        NOW
      ).error
    ).toBe('final');
  });
});

describe('settings', () => {
  afterEach(() => {
    delete process.env.JOB_LEASE_SECONDS;
    delete process.env.JOB_MAX_ATTEMPTS;
  });

  test('the lease defaults to 110 s and can be overridden', () => {
    expect(Job.leaseSeconds()).toBe(110);
    process.env.JOB_LEASE_SECONDS = '30';
    expect(Job.leaseSeconds()).toBe(30);
  });

  test('a nonsense lease setting falls back to the default', () => {
    for (const bad of ['abc', '0', '']) {
      process.env.JOB_LEASE_SECONDS = bad;
      expect(Job.leaseSeconds()).toBe(110);
    }
  });

  test('attempts default to 3 and can be overridden', () => {
    expect(Job.maxAttempts()).toBe(3);
    process.env.JOB_MAX_ATTEMPTS = '5';
    expect(Job.maxAttempts()).toBe(5);
    process.env.JOB_MAX_ATTEMPTS = 'x';
    expect(Job.maxAttempts()).toBe(3);
  });
});
