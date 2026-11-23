// tests/unit/search-api.test.js

// GET /v1/search, the indexing hooks on create/update/delete, and the worker
// handling "embed" messages. Queue mocked; in-memory store; fake embedder.

process.env.EMBEDDER = 'fake';

jest.mock('../../src/queue', () => ({
  isEnabled: jest.fn(),
  sendJob: jest.fn(),
  sendEmbed: jest.fn(),
  receive: jest.fn(),
  remove: jest.fn(),
  delay: jest.fn(),
}));

const request = require('supertest');
const app = require('../../src/app');
const queue = require('../../src/queue');
const Job = require('../../src/model/job');
const { setEmbedder } = require('../../src/search/embedder');
const { listChunks } = require('../../src/model/data');
const { processMessage } = require('../../src/worker-core');

const user1 = ['test-user1@fragments-testing.com', 'test-password1'];
const user2 = ['test-user2@fragments-testing', 'test-password2'];

const create = (type, body, auth = user1) =>
  request(app)
    .post('/v1/fragments')
    .auth(...auth)
    .set('Content-Type', type)
    .send(body);
const find = (query, auth = user1) =>
  request(app)
    .get(`/v1/search${query}`)
    .auth(...auth);

// Run what the API queued, as the worker would
const runQueued = async () => {
  const calls = queue.sendEmbed.mock.calls.splice(0);
  for (const [m] of calls) {
    const message = {
      id: 'm',
      handle: 'h',
      receiveCount: 1,
      body: JSON.stringify({ kind: 'embed', ...m }),
    };
    await processMessage(message, { queue });
  }
  return calls.length;
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SEARCH_ENABLED = '1';
  queue.isEnabled.mockReturnValue(true);
  queue.sendEmbed.mockResolvedValue();
});
afterEach(() => {
  delete process.env.SEARCH_ENABLED;
  setEmbedder(undefined);
});

describe('GET /v1/search', () => {
  test('unauthenticated requests are denied', async () => {
    await request(app).get('/v1/search?q=x').expect(401);
  });

  test('without an index (memory mode) answers 501 with the reason', async () => {
    delete process.env.SEARCH_ENABLED;
    const res = await find('?q=anything');
    expect(res.statusCode).toBe(501);
    expect(res.body.error).toEqual({
      code: 501,
      message: 'Search needs the embeddings table (not available in memory mode)',
    });
  });

  test.each([[''], ['?q='], ['?q=%20%20'], [`?q=${'x'.repeat(501)}`]])(
    'a missing or oversized q (%s) is 400',
    async (query) => {
      const res = await find(query);
      expect(res.statusCode).toBe(400);
      expect(res.body.error.message).toBe('q is required and must be at most 500 characters');
    }
  );

  test('a q of exactly 500 characters is fine', async () => {
    expect((await find(`?q=${'x'.repeat(500)}`)).statusCode).toBe(200);
  });

  test.each([['0'], ['21'], ['1.5'], ['abc'], ['-1']])('k=%s is 400', async (k) => {
    const res = await find(`?q=hello&k=${k}`);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toBe('k must be a whole number from 1 to 20');
  });

  test('k=1 and k=20 are the smallest and largest allowed', async () => {
    expect((await find('?q=hello&k=1')).statusCode).toBe(200);
    expect((await find('?q=hello&k=20')).statusCode).toBe(200);
  });

  test('end to end: create text, let the worker index it, search finds it; another user finds nothing', async () => {
    const hit = (
      await create('text/markdown', '# Pasta night\nTomato and basil sauce for a quick dinner')
    ).body.fragment;
    await create('text/plain', 'Linux kernel scheduler and process memory notes');
    expect(await runQueued()).toBe(2);

    const res = await find('?q=tomato%20pasta%20dinner&k=2');
    expect(res.statusCode).toBe(200);
    expect(res.body.query).toBe('tomato pasta dinner');
    expect(res.body.results[0]).toMatchObject({ id: hit.id, type: 'text/markdown' });
    expect(res.body.results[0].snippet).toContain('Tomato');
    expect(res.body.results[0].score).toBeGreaterThan(res.body.results[1].score);

    const other = await find('?q=tomato%20pasta%20dinner', user2);
    expect(other.body.results).toEqual([]);
  });

  test('a search failure is a 500 with a message', async () => {
    setEmbedder(async () => {
      throw new Error('bedrock down');
    });
    const res = await find('?q=hello');
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toEqual({ code: 500, message: 'Unable to search' });
  });
});

describe('indexing hooks', () => {
  test('creating a text fragment queues it for indexing with its owner, id and version', async () => {
    const f = (await create('text/plain', 'hello world')).body.fragment;
    expect(queue.sendEmbed).toHaveBeenCalledTimes(1);
    expect(queue.sendEmbed).toHaveBeenCalledWith({
      ownerId: f.ownerId,
      fragmentId: f.id,
      updated: expect.any(String),
      requestId: expect.any(String),
    });
  });

  test.each(['text/markdown', 'text/html'])('%s is indexed too', async (type) => {
    await create(type, '<p>x</p>');
    expect(queue.sendEmbed).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['image/png', Buffer.from('x')],
    ['application/json', '{}'],
    ['text/csv', 'a,b'],
  ])('%s is not queued', async (type, body) => {
    await create(type, body);
    expect(queue.sendEmbed).not.toHaveBeenCalled();
  });

  test('nothing is queued when search is off or there is no queue', async () => {
    delete process.env.SEARCH_ENABLED;
    await create('text/plain', 'x');
    process.env.SEARCH_ENABLED = '1';
    queue.isEnabled.mockReturnValue(false);
    await create('text/plain', 'x');
    expect(queue.sendEmbed).not.toHaveBeenCalled();
  });

  test('a queue failure does not fail the request', async () => {
    queue.sendEmbed.mockRejectedValueOnce(new Error('SQS down'));
    const res = await create('text/plain', 'still saved');
    expect(res.statusCode).toBe(201);
  });

  test("updating queues a new version; the old version's message is then skipped as stale", async () => {
    const f = (await create('text/plain', 'first version')).body.fragment;
    const first = queue.sendEmbed.mock.calls[0][0];
    await new Promise((r) => setTimeout(r, 5));
    await request(app)
      .put(`/v1/fragments/${f.id}`)
      .auth(...user1)
      .set('Content-Type', 'text/plain')
      .send('second version');
    const second = queue.sendEmbed.mock.calls[1][0];
    expect(second.fragmentId).toBe(f.id);
    expect(second.updated).not.toBe(first.updated);

    const stale = {
      id: 'm',
      handle: 'h',
      receiveCount: 1,
      body: JSON.stringify({ kind: 'embed', ...first }),
    };
    expect(await processMessage(stale, { queue })).toBe('skipped');
    expect(await listChunks(f.ownerId)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ fragmentId: f.id })])
    );
  });

  test('deleting a fragment removes it from the index', async () => {
    const f = (await create('text/plain', 'to be deleted')).body.fragment;
    await runQueued();
    expect((await listChunks(f.ownerId)).some((c) => c.fragmentId === f.id)).toBe(true);

    await request(app)
      .delete(`/v1/fragments/${f.id}`)
      .auth(...user1)
      .expect(200);
    expect((await listChunks(f.ownerId)).some((c) => c.fragmentId === f.id)).toBe(false);
  });
});

describe('the worker and "embed" messages', () => {
  const embedMessage = (body, extra = {}) => ({
    id: 'm',
    handle: 'h',
    receiveCount: 1,
    body: JSON.stringify({ kind: 'embed', ...body }),
    ...extra,
  });
  const fresh = async () => {
    const f = (await create('text/plain', 'indexable text for the worker')).body.fragment;
    return queue.sendEmbed.mock.calls.pop()[0] && f;
  };

  test('indexes, acknowledges the message, and is idempotent', async () => {
    const f = await fresh();
    const body = { ownerId: f.ownerId, fragmentId: f.id, updated: f.updated };
    expect(await processMessage(embedMessage(body), { queue })).toBe('embedded');
    expect(queue.remove).toHaveBeenCalledWith('h');
    const once = (await listChunks(f.ownerId)).filter((c) => c.fragmentId === f.id);
    expect(await processMessage(embedMessage(body), { queue })).toBe('embedded');
    expect((await listChunks(f.ownerId)).filter((c) => c.fragmentId === f.id)).toHaveLength(
      once.length
    );
  });

  test('a message for a fragment that no longer exists is dropped quietly', async () => {
    const f = await fresh();
    await request(app)
      .delete(`/v1/fragments/${f.id}`)
      .auth(...user1);
    expect(
      await processMessage(embedMessage({ ownerId: f.ownerId, fragmentId: f.id }), { queue })
    ).toBe('skipped');
    expect(queue.remove).toHaveBeenCalled();
  });

  test('an embedding failure is retried with backoff, not dropped', async () => {
    const f = await fresh();
    setEmbedder(async () => {
      throw new Error('throttled');
    });
    expect(
      await processMessage(embedMessage({ ownerId: f.ownerId, fragmentId: f.id }), { queue })
    ).toBe('retry');
    expect(queue.delay).toHaveBeenCalledWith('h', 10);
    expect(queue.remove).not.toHaveBeenCalled();
  });

  test('on the last delivery it gives up and acknowledges', async () => {
    const f = await fresh();
    setEmbedder(async () => {
      throw new Error('still failing');
    });
    const message = embedMessage(
      { ownerId: f.ownerId, fragmentId: f.id },
      { receiveCount: Job.maxAttempts() }
    );
    expect(await processMessage(message, { queue })).toBe('failed');
    expect(queue.remove).toHaveBeenCalledWith('h');
  });

  test('a malformed embed message is discarded', async () => {
    expect(await processMessage(embedMessage({ ownerId: 'o' }), { queue })).toBe('discarded');
    expect(await processMessage(embedMessage({ fragmentId: 'f' }), { queue })).toBe('discarded');
    expect(queue.remove).toHaveBeenCalledTimes(2);
  });
});
