// tests/unit/jobs-api.test.js

// POST /v1/fragments/:id/jobs and GET /v1/jobs/:jobId, with the queue mocked.
// The in-memory store stands in for DynamoDB.

jest.mock('../../src/queue', () => ({
  isEnabled: jest.fn(),
  sendJob: jest.fn(),
  receive: jest.fn(),
  remove: jest.fn(),
  delay: jest.fn(),
}));

const request = require('supertest');
const sharp = require('sharp');
const app = require('../../src/app');
const queue = require('../../src/queue');
const Job = require('../../src/model/job');
const { claimJob, readJob } = require('../../src/model/data');
const { processMessage } = require('../../src/worker-core');

const user1 = ['test-user1@fragments-testing.com', 'test-password1'];
const user2 = ['test-user2@fragments-testing', 'test-password2'];

const createFragment = async (type, body, auth = user1) =>
  (
    await request(app)
      .post('/v1/fragments')
      .auth(...auth)
      .set('Content-Type', type)
      .send(body)
  ).body.fragment;

const postJob = (id, body, auth = user1, headers = {}) =>
  request(app)
    .post(`/v1/fragments/${id}/jobs`)
    .auth(...auth)
    .set(headers)
    .send(body);

const getJob = (jobId, auth = user1) =>
  request(app)
    .get(`/v1/jobs/${jobId}`)
    .auth(...auth);

beforeEach(() => {
  jest.clearAllMocks();
  queue.isEnabled.mockReturnValue(true);
  queue.sendJob.mockResolvedValue();
});

describe('POST /v1/fragments/:id/jobs', () => {
  test('unauthenticated requests are denied', async () => {
    await request(app).post('/v1/fragments/x/jobs').send({ to: '.html' }).expect(401);
    await request(app).get('/v1/jobs/x').expect(401);
  });

  test('without a queue (memory mode) answers 501', async () => {
    queue.isEnabled.mockReturnValue(false);
    const fragment = await createFragment('text/markdown', '# hi');
    const res = await postJob(fragment.id, { to: '.html' });
    expect(res.statusCode).toBe(501);
    expect(res.body.error.message).toContain('SQS');
    const get = await request(app)
      .get('/v1/jobs/anything')
      .auth(...user1);
    expect(get.statusCode).toBe(404); // reading is harmless; there just are no jobs
  });

  test('queues a job and answers 202 with a Location to poll', async () => {
    const fragment = await createFragment('text/markdown', '# hi');
    const res = await postJob(fragment.id, { to: '.html' }, user1, { 'X-Request-Id': 'trace-abc' });

    expect(res.statusCode).toBe(202);
    const { job } = res.body;
    expect(job).toMatchObject({
      fragmentId: fragment.id,
      to: 'text/html',
      status: 'queued',
      attempts: 0,
      requestId: 'trace-abc',
    });
    expect(res.headers.location).toMatch(new RegExp(`/v1/jobs/${job.id}$`));
    // the message carries the job, its owner and the request id, and nothing else
    expect(queue.sendJob).toHaveBeenCalledTimes(1);
    expect(queue.sendJob).toHaveBeenCalledWith({
      jobId: job.id,
      ownerId: expect.any(String),
      requestId: 'trace-abc',
    });
  });

  test('extension is case-insensitive and width is passed along for images', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    const fragment = await createFragment('image/png', png);
    const res = await postJob(fragment.id, { to: '.WEBP', width: 4 });
    expect(res.statusCode).toBe(202);
    expect(res.body.job).toMatchObject({ to: 'image/webp', width: 4 });
  });

  test('unknown fragment is 404 and nothing is queued', async () => {
    const res = await postJob('no-such-fragment', { to: '.html' });
    expect(res.statusCode).toBe(404);
    expect(queue.sendJob).not.toHaveBeenCalled();
  });

  test("another user's fragment is 404 too", async () => {
    const fragment = await createFragment('text/markdown', '# mine');
    expect((await postJob(fragment.id, { to: '.html' }, user2)).statusCode).toBe(404);
    expect(queue.sendJob).not.toHaveBeenCalled();
  });

  test.each([
    ['no body', undefined],
    ['missing to', {}],
    ['to is not a string', { to: 5 }],
    ['unknown extension', { to: '.exe' }],
    ['extension without a dot', { to: 'html' }],
    ['width is a string', { to: '.html', width: '100' }],
    ['width is 0', { to: '.html', width: 0 }],
    ['width is fractional', { to: '.html', width: 1.5 }],
    ['width over the maximum', { to: '.html', width: 4097 }],
  ])('invalid request body (%s) is 400', async (_name, body) => {
    const fragment = await createFragment('text/markdown', '# hi');
    const res = await postJob(fragment.id, body);
    expect(res.statusCode).toBe(400);
    expect(queue.sendJob).not.toHaveBeenCalled();
  });

  test('malformed JSON is 400 and an oversized body is 413', async () => {
    const fragment = await createFragment('text/markdown', '# hi');
    const bad = await request(app)
      .post(`/v1/fragments/${fragment.id}/jobs`)
      .auth(...user1)
      .set('Content-Type', 'application/json')
      .send('{"to": ');
    expect(bad.statusCode).toBe(400);
    const big = await postJob(fragment.id, { to: '.html', padding: 'x'.repeat(2000) });
    expect(big.statusCode).toBe(413);
  });

  test('a conversion the fragment type does not support is 415', async () => {
    const fragment = await createFragment('text/plain', 'plain');
    const res = await postJob(fragment.id, { to: '.avif' });
    expect(res.statusCode).toBe(415);
    expect(res.body.error.message).toContain('text/plain');
  });

  test('width on a non-image is 400', async () => {
    const fragment = await createFragment('text/markdown', '# hi');
    expect((await postJob(fragment.id, { to: '.html', width: 10 })).statusCode).toBe(400);
  });

  test('converting to its own type is pointless (400), unless resizing an image', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    const text = await createFragment('text/markdown', '# hi');
    expect((await postJob(text.id, { to: '.md' })).statusCode).toBe(400);
    const image = await createFragment('image/png', png);
    expect((await postJob(image.id, { to: '.png' })).statusCode).toBe(400);
    expect((await postJob(image.id, { to: '.png', width: 4 })).statusCode).toBe(202);
  });

  test('if the message cannot be queued the job is removed and the client is told to retry', async () => {
    queue.sendJob.mockRejectedValueOnce(new Error('SQS down'));
    const removeSpy = jest.spyOn(Job, 'remove');
    const fragment = await createFragment('text/markdown', '# hi');

    const res = await postJob(fragment.id, { to: '.html' });
    expect(res.statusCode).toBe(503);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    // no orphan job is left that would stay `queued` forever
    const [ownerId, jobId] = removeSpy.mock.calls[0];
    expect(await readJob(ownerId, jobId)).toBeUndefined();
    removeSpy.mockRestore();
  });
});

describe('GET /v1/jobs/:jobId', () => {
  test('shows a queued job', async () => {
    const fragment = await createFragment('text/markdown', '# hi');
    const { job } = (await postJob(fragment.id, { to: '.html' })).body;
    const res = await getJob(job.id);
    expect(res.statusCode).toBe(200);
    expect(res.body.job).toMatchObject({ id: job.id, status: 'queued', to: 'text/html' });
  });

  test('unknown job is 404', async () => {
    expect((await getJob('no-such-job')).statusCode).toBe(404);
  });

  test("another user's job is 404, exactly like a job that does not exist", async () => {
    const fragment = await createFragment('text/markdown', '# private');
    const { job } = (await postJob(fragment.id, { to: '.html' })).body;

    const stranger = await getJob(job.id, user2);
    const missing = await getJob('no-such-job', user2);
    expect(stranger.statusCode).toBe(404);
    expect(stranger.body).toEqual(missing.body);
    expect((await getJob(job.id)).statusCode).toBe(200); // the owner still sees it
  });

  test('end to end: post a job, let the worker handle the queued message, read the result', async () => {
    const fragment = await createFragment('text/markdown', '# End to end');
    const post = await postJob(fragment.id, { to: '.html' }, user1, { 'X-Request-Id': 'e2e-1' });
    const { job } = post.body;

    // the message the API sent is what the worker receives
    const [sent] = queue.sendJob.mock.calls[0];
    const msg = {
      id: 'm1',
      handle: 'h1',
      receiveCount: 1,
      requestId: sent.requestId,
      body: JSON.stringify({ jobId: sent.jobId, ownerId: sent.ownerId }),
    };
    expect(await processMessage(msg, { queue })).toBe('succeeded');

    const res = await getJob(job.id);
    expect(res.body.job).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(res.body.job.result).toMatchObject({ type: 'text/html' });
    expect(res.body.job.result.size).toBeGreaterThan(0);
    expect(res.body.job).not.toHaveProperty('error');
  });

  test('a failed job shows its error', async () => {
    const fragment = await createFragment('application/json', '{bad');
    const { job } = (await postJob(fragment.id, { to: '.yaml' })).body;
    const [sent] = queue.sendJob.mock.calls[0];
    const msg = (receiveCount) => ({
      id: 'm',
      handle: 'h',
      receiveCount,
      body: JSON.stringify({ jobId: sent.jobId, ownerId: sent.ownerId }),
    });
    for (const n of [1, 2, 3]) await processMessage(msg(n), { queue });

    const res = await getJob(job.id);
    expect(res.body.job.status).toBe('failed');
    expect(res.body.job.error).toBeTruthy();
    expect(res.body.job).not.toHaveProperty('result');
  });

  test('a job whose worker died on the last attempt is reported failed, not running forever', async () => {
    const fragment = await createFragment('text/markdown', '# hi');
    const { job } = (await postJob(fragment.id, { to: '.html' })).body;
    const [sent] = queue.sendJob.mock.calls[0];
    // three attempts, each claimed and abandoned (the worker was killed every time)
    const long = Job.nowSeconds() - 10_000;
    for (let i = 0; i < Job.maxAttempts(); i++) {
      await claimJob(sent.ownerId, sent.jobId, long + i * 20, 10);
    }

    const res = await getJob(job.id);
    expect(res.body.job.status).toBe('failed');
    expect(res.body.job.error).toContain('worker did not finish');
  });
});
