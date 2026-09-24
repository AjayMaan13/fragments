// Unit tests for expiring fragments (?expiresIn=<seconds> on POST)

const request = require('supertest');
const app = require('../../src/app');
const { Fragment } = require('../../src/model/fragment');

const auth = ['test-user1@fragments-testing.com', 'test-password1'];

const create = (query = '') =>
  request(app)
    .post(`/v1/fragments${query}`)
    .auth(...auth)
    .set('Content-Type', 'text/plain')
    .send('temporary');

describe('expiring fragments', () => {
  afterEach(() => jest.restoreAllMocks());

  test('POST without expiresIn creates a fragment with no expiresAt', async () => {
    const res = await create();
    expect(res.statusCode).toBe(201);
    expect(res.body.fragment).not.toHaveProperty('expiresAt');
  });

  test('POST with expiresIn sets expiresAt to now + that many seconds (Unix seconds)', async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await create('?expiresIn=60');
    const after = Math.floor(Date.now() / 1000);

    expect(res.statusCode).toBe(201);
    expect(res.body.fragment.expiresAt).toBeGreaterThanOrEqual(before + 60);
    expect(res.body.fragment.expiresAt).toBeLessThanOrEqual(after + 60);
  });

  test.each(['abc', '0', '-5', '1.5', '', '99999999999'])(
    'POST with invalid expiresIn=%p is rejected with 400',
    async (value) => {
      const res = await create(`?expiresIn=${value}`);
      expect(res.statusCode).toBe(400);
      expect(res.body.status).toBe('error');
    }
  );

  test('a fragment is readable until it expires, then behaves as if it does not exist', async () => {
    const { id } = (await create('?expiresIn=60')).body.fragment;
    const get = (path = '') =>
      request(app)
        .get(`/v1/fragments/${id}${path}`)
        .auth(...auth);

    expect((await get()).statusCode).toBe(200);
    expect((await get('/info')).statusCode).toBe(200);

    // Jump the clock past the expiry instead of waiting
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61 * 1000);

    expect((await get()).statusCode).toBe(404);
    expect((await get('/info')).statusCode).toBe(404);
    const del = await request(app)
      .delete(`/v1/fragments/${id}`)
      .auth(...auth);
    expect(del.statusCode).toBe(404);
  });

  test('expired fragments are left out of both kinds of listing', async () => {
    const { id } = (await create('?expiresIn=60')).body.fragment;
    const list = (expand) =>
      request(app)
        .get(`/v1/fragments${expand ? '?expand=1' : ''}`)
        .auth(...auth);

    expect((await list(false)).body.fragments).toContain(id);
    expect((await list(true)).body.fragments.map((f) => f.id)).toContain(id);

    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61 * 1000);

    expect((await list(false)).body.fragments).not.toContain(id);
    expect((await list(true)).body.fragments.map((f) => f.id)).not.toContain(id);
  });

  test('updating a fragment keeps its expiry', async () => {
    const created = (await create('?expiresIn=600')).body.fragment;
    const put = await request(app)
      .put(`/v1/fragments/${created.id}`)
      .auth(...auth)
      .set('Content-Type', 'text/plain')
      .send('updated');

    expect(put.statusCode).toBe(200);
    expect(put.body.fragment.expiresAt).toBe(created.expiresAt);
  });
});

describe('Fragment model expiry', () => {
  const base = { ownerId: 'owner', type: 'text/plain' };

  test('expiresAt must be an integer', () => {
    expect(() => new Fragment({ ...base, expiresAt: 'soon' })).toThrow(/expiresAt/);
    expect(() => new Fragment({ ...base, expiresAt: 1.5 })).toThrow(/expiresAt/);
  });

  test('isExpired is false without expiresAt and for future times, true for past or present', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(new Fragment(base).isExpired).toBe(false);
    expect(new Fragment({ ...base, expiresAt: now + 100 }).isExpired).toBe(false);
    expect(new Fragment({ ...base, expiresAt: now - 1 }).isExpired).toBe(true);
    expect(new Fragment({ ...base, expiresAt: now }).isExpired).toBe(true);
  });
});
