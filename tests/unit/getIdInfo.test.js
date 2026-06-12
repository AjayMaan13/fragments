// Unit tests for GET /v1/fragments/:id/info

const request = require('supertest');
const app = require('../../src/app');

describe('GET /v1/fragments/:id/info', () => {
  test('unauthenticated requests are denied', () =>
    request(app).get('/v1/fragments/someId/info').expect(401));

  test('unknown id returns 404', () =>
    request(app)
      .get('/v1/fragments/does-not-exist/info')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .expect(404));

  test('returns the metadata for an existing fragment', async () => {
    const post = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/plain')
      .send('hello world');

    const { id } = post.body.fragment;

    const res = await request(app)
      .get(`/v1/fragments/${id}/info`)
      .auth('test-user1@fragments-testing.com', 'test-password1');

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.fragment.id).toBe(id);
    expect(res.body.fragment.type).toContain('text/plain');
    expect(res.body.fragment.size).toBe(Buffer.byteLength('hello world'));
  });
});
