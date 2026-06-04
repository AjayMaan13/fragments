// Unit tests for GET /v1/fragments/:id

const request = require('supertest');
const app = require('../../src/app');

describe('GET /v1/fragments/:id', () => {
  test('unauthenticated requests are denied', () =>
    request(app).get('/v1/fragments/someId').expect(401));

  test('unknown id returns 404', () =>
    request(app)
      .get('/v1/fragments/does-not-exist')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .expect(404));

  test('returns the raw data and correct Content-Type for an existing fragment', async () => {
    const post = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/plain')
      .send('hello world');

    const { id } = post.body.fragment;

    const res = await request(app)
      .get(`/v1/fragments/${id}`)
      .auth('test-user1@fragments-testing.com', 'test-password1');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toBe('hello world');
  });

  test('authenticated user cannot access a non-existent fragment id', () =>
    request(app)
      .get('/v1/fragments/totally-fake-id')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .expect(404));
});
