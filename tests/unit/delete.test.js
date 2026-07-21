// Unit tests for DELETE /v1/fragments/:id

const request = require('supertest');
const app = require('../../src/app');

describe('DELETE /v1/fragments/:id', () => {
  test('unauthenticated requests are denied', () =>
    request(app).delete('/v1/fragments/some-id').expect(401));

  test('incorrect credentials are denied', () =>
    request(app)
      .delete('/v1/fragments/some-id')
      .auth('invalid@email.com', 'wrongpassword')
      .expect(401));

  test('deleting an unknown fragment id returns 404', () =>
    request(app)
      .delete('/v1/fragments/does-not-exist')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .expect(404));

  test('authenticated users can delete an existing fragment', async () => {
    const postRes = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/plain')
      .send('This will be deleted');

    const { id } = postRes.body.fragment;

    const deleteRes = await request(app)
      .delete(`/v1/fragments/${id}`)
      .auth('test-user1@fragments-testing.com', 'test-password1');

    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.body.status).toBe('ok');

    // Confirm it's actually gone
    await request(app)
      .get(`/v1/fragments/${id}`)
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .expect(404);
  });

  test("a user cannot delete another user's fragment", async () => {
    const postRes = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/plain')
      .send('owned by user1');

    const { id } = postRes.body.fragment;

    const deleteRes = await request(app)
      .delete(`/v1/fragments/${id}`)
      .auth('test-user2@fragments-testing', 'test-password2');

    expect(deleteRes.statusCode).toBe(404);

    // Confirm it's still there for the real owner
    await request(app)
      .get(`/v1/fragments/${id}`)
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .expect(200);
  });
});
