// Unit tests for the fragment view counter

const request = require('supertest');
const app = require('../../src/app');
const { Fragment } = require('../../src/model/fragment');
const { incrementViews } = require('../../src/model/data/memory');

const auth = ['test-user1@fragments-testing.com', 'test-password1'];

const create = (type = 'text/plain', body = 'hello') =>
  request(app)
    .post('/v1/fragments')
    .auth(...auth)
    .set('Content-Type', type)
    .send(body);

const viewsOf = async (id) => {
  const res = await request(app)
    .get(`/v1/fragments/${id}/info`)
    .auth(...auth);
  return res.body.fragment.viewCount;
};

const read = (id, ext = '') =>
  request(app)
    .get(`/v1/fragments/${id}${ext}`)
    .auth(...auth);

describe('view counter', () => {
  afterEach(() => jest.restoreAllMocks());

  test('a new fragment starts at 0 views', async () => {
    const res = await create();
    expect(res.body.fragment.viewCount).toBe(0);
  });

  test('each read of the data adds one view', async () => {
    const { id } = (await create()).body.fragment;

    await read(id);
    await read(id);
    await read(id);

    expect(await viewsOf(id)).toBe(3);
  });

  test('reading /info does not count as a view', async () => {
    const { id } = (await create()).body.fragment;

    await viewsOf(id);
    await viewsOf(id);

    expect(await viewsOf(id)).toBe(0);
  });

  test('converted reads count as views too', async () => {
    const { id } = (await create('text/markdown', '# hi')).body.fragment;

    await read(id, '.html');

    expect(await viewsOf(id)).toBe(1);
  });

  test('updating a fragment does not reset its view count', async () => {
    const { id } = (await create()).body.fragment;
    await read(id);
    await read(id);

    const put = await request(app)
      .put(`/v1/fragments/${id}`)
      .auth(...auth)
      .set('Content-Type', 'text/plain')
      .send('changed');

    expect(put.statusCode).toBe(200);
    expect(await viewsOf(id)).toBe(2);
  });

  test('reading an unknown fragment is still a 404 and counts nothing', async () => {
    expect((await read('does-not-exist')).statusCode).toBe(404);
  });

  test('a failure to record the view does not stop the read', async () => {
    const { id } = (await create()).body.fragment;
    jest.spyOn(Fragment.prototype, 'recordView').mockRejectedValue(new Error('db down'));

    const res = await read(id);

    expect(res.statusCode).toBe(200);
    expect(res.text).toBe('hello');
  });
});

describe('memory backend incrementViews', () => {
  test('throws for a fragment that does not exist', async () => {
    await expect(incrementViews('nobody', 'nothing')).rejects.toThrow(/missing entry/);
  });
});

describe('Fragment model views', () => {
  test('viewCount defaults to 0 and recordView returns the new total', async () => {
    const fragment = new Fragment({ ownerId: 'view-owner', type: 'text/plain' });
    expect(fragment.viewCount).toBe(0);

    await fragment.save();
    expect(await fragment.recordView()).toBe(1);
    expect(await fragment.recordView()).toBe(2);
    expect(fragment.viewCount).toBe(2);
  });
});
