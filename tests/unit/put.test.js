// Unit tests for PUT /v1/fragments/:id

const request = require('supertest');
const app = require('../../src/app');

describe('PUT /v1/fragments/:id', () => {
  test('unauthenticated requests are denied', () =>
    request(app).put('/v1/fragments/some-id').send('hello').expect(401));

  test('incorrect credentials are denied', () =>
    request(app)
      .put('/v1/fragments/some-id')
      .auth('invalid@email.com', 'wrongpassword')
      .send('hello')
      .expect(401));

  test('updating an unknown fragment id returns 404', () =>
    request(app)
      .put('/v1/fragments/does-not-exist')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/plain')
      .send('nope')
      .expect(404));

  test('authenticated users can update an existing fragment with matching Content-Type', async () => {
    const postRes = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/plain')
      .send('This is a fragment');

    const { id } = postRes.body.fragment;

    const putRes = await request(app)
      .put(`/v1/fragments/${id}`)
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/plain')
      .send('This is updated, longer content');

    expect(putRes.statusCode).toBe(200);
    expect(putRes.body.status).toBe('ok');
    expect(putRes.body.fragment.id).toBe(id);
    expect(putRes.body.fragment.type).toBe('text/plain');
    expect(putRes.body.fragment.size).toBe(31);

    // Confirm the data itself was actually updated
    const getRes = await request(app)
      .get(`/v1/fragments/${id}`)
      .auth('test-user1@fragments-testing.com', 'test-password1');
    expect(getRes.text).toBe('This is updated, longer content');
  });

  test('updated timestamp changes after a PUT', async () => {
    const postRes = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/plain')
      .send('original');

    const { id, updated: originalUpdated } = postRes.body.fragment;

    const putRes = await request(app)
      .put(`/v1/fragments/${id}`)
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/plain')
      .send('changed');

    expect(putRes.body.fragment.updated).not.toBe(originalUpdated);
  });

  test('changing the Content-Type on update returns 400', async () => {
    const postRes = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/plain')
      .send('This is a fragment');

    const { id } = postRes.body.fragment;

    const putRes = await request(app)
      .put(`/v1/fragments/${id}`)
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ a: 1 }));

    expect(putRes.statusCode).toBe(400);
    expect(putRes.body.status).toBe('error');
  });

  test('an unsupported Content-Type on update returns 400', async () => {
    const postRes = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/plain')
      .send('This is a fragment');

    const { id } = postRes.body.fragment;

    const putRes = await request(app)
      .put(`/v1/fragments/${id}`)
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'application/msword')
      .send('nope');

    expect(putRes.statusCode).toBe(400);
  });

  test("a user cannot update another user's fragment", async () => {
    const postRes = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/plain')
      .send('owned by user1');

    const { id } = postRes.body.fragment;

    const putRes = await request(app)
      .put(`/v1/fragments/${id}`)
      .auth('test-user2@fragments-testing', 'test-password2')
      .set('Content-Type', 'text/plain')
      .send('hijacked by user2');

    expect(putRes.statusCode).toBe(404);
  });
});
