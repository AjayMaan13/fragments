// tests/unit/get.test.js

const request = require('supertest');
const app = require('../../src/app');

describe('GET /v1/fragments', () => {
  // If the request is missing the Authorization header, it should be forbidden
  test('unauthenticated requests are denied', () => request(app).get('/v1/fragments').expect(401));

  // If the wrong username/password pair are used (no such user), it should be forbidden
  test('incorrect credentials are denied', () =>
    request(app).get('/v1/fragments').auth('invalid@email.com', 'incorrect_password').expect(401));

  // Using a valid username/password pair should give a success result with a .fragments array
  test('authenticated users get a fragments array', async () => {
    const res = await request(app)
      .get('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.fragments)).toBe(true);
  });

  // After creating a fragment, its id appears in the list
  test('created fragment id appears in the list', async () => {
    const post = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/plain')
      .send('hello');

    const get = await request(app)
      .get('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1');

    expect(get.body.fragments).toContain(post.body.fragment.id);
  });

  // expand=1 returns full fragment objects instead of just ids
  test('expand=1 returns full fragment objects', async () => {
    await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/plain')
      .send('hello expanded');

    const res = await request(app)
      .get('/v1/fragments?expand=1')
      .auth('test-user1@fragments-testing.com', 'test-password1');

    expect(res.statusCode).toBe(200);
    expect(res.body.fragments[0]).toHaveProperty('id');
    expect(res.body.fragments[0]).toHaveProperty('ownerId');
    expect(res.body.fragments[0]).toHaveProperty('type');
    expect(res.body.fragments[0]).toHaveProperty('size');
  });
});
