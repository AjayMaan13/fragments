// Unit tests for GET /v1/fragments/:id/share (temporary public links)

// The in-memory backend can't make real links, so replace just that function
// to check what the model asks the storage layer to sign.
jest.mock('../../src/model/data/memory', () => ({
  ...jest.requireActual('../../src/model/data/memory'),
  createShareUrl: jest.fn(),
}));

const request = require('supertest');
const app = require('../../src/app');
const { createShareUrl } = require('../../src/model/data/memory');

const auth = ['test-user1@fragments-testing.com', 'test-password1'];

const create = (type = 'text/plain', query = '') =>
  request(app)
    .post(`/v1/fragments${query}`)
    .auth(...auth)
    .set('Content-Type', type)
    .send('shared content');

const share = (id, query = '') =>
  request(app)
    .get(`/v1/fragments/${id}/share${query}`)
    .auth(...auth);

describe('GET /v1/fragments/:id/share', () => {
  beforeEach(() => {
    createShareUrl.mockReset();
    createShareUrl.mockResolvedValue('https://signed.example/link');
  });
  afterEach(() => jest.restoreAllMocks());

  test('unauthenticated requests are denied', () =>
    request(app).get('/v1/fragments/someId/share').expect(401));

  test('unknown fragment returns 404', async () => {
    expect((await share('does-not-exist')).statusCode).toBe(404);
  });

  test.each(['abc', '0', '-1', '1.5', '3601', ''])(
    'invalid expiresIn=%p returns 400',
    async (value) => {
      const { id } = (await create()).body.fragment;
      expect((await share(id, `?expiresIn=${value}`)).statusCode).toBe(400);
    }
  );

  test('returns the signed url with a 15 minute default lifetime', async () => {
    const { id } = (await create()).body.fragment;
    const before = Math.floor(Date.now() / 1000);

    const res = await share(id);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.url).toBe('https://signed.example/link');
    expect(res.body.expiresIn).toBe(900);
    expect(res.body.expiresAt).toBeGreaterThanOrEqual(before + 900);
    expect(createShareUrl).toHaveBeenCalledWith(expect.any(String), id, 900, 'text/plain');
  });

  test('honours a requested lifetime', async () => {
    const { id } = (await create()).body.fragment;

    const res = await share(id, '?expiresIn=120');

    expect(res.body.expiresIn).toBe(120);
    expect(createShareUrl).toHaveBeenCalledWith(expect.any(String), id, 120, 'text/plain');
  });

  test('a link never outlives the fragment it points to', async () => {
    const { id } = (await create('text/plain', '?expiresIn=60')).body.fragment;

    const res = await share(id, '?expiresIn=600');

    expect(res.statusCode).toBe(200);
    expect(res.body.expiresIn).toBeLessThanOrEqual(60);
    expect(res.body.expiresIn).toBeGreaterThanOrEqual(58);
  });

  test('an expired fragment cannot be shared', async () => {
    const { id } = (await create('text/plain', '?expiresIn=60')).body.fragment;
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61 * 1000);

    expect((await share(id)).statusCode).toBe(404);
  });

  test('keeps the fragment type (including charset) as the served Content-Type', async () => {
    const { id } = (await create('application/json; charset=utf-8')).body.fragment;

    await share(id);

    expect(createShareUrl).toHaveBeenCalledWith(
      expect.any(String),
      id,
      900,
      'application/json; charset=utf-8'
    );
  });

  test('HTML is served as plain text so it is never rendered from the storage domain', async () => {
    const { id } = (await create('text/html')).body.fragment;

    await share(id);

    expect(createShareUrl).toHaveBeenCalledWith(expect.any(String), id, 900, 'text/plain');
  });

  test('returns 501 when the storage backend cannot create links (memory mode)', async () => {
    createShareUrl.mockResolvedValue(undefined);
    const { id } = (await create()).body.fragment;

    expect((await share(id)).statusCode).toBe(501);
  });

  test('returns 500 when signing fails', async () => {
    createShareUrl.mockRejectedValue(new Error('no credentials'));
    const { id } = (await create()).body.fragment;

    expect((await share(id)).statusCode).toBe(500);
  });
});
