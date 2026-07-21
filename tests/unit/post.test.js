// Unit tests for POST /v1/fragments

const request = require('supertest');
const app = require('../../src/app');

describe('POST /v1/fragments', () => {
  test('unauthenticated requests are denied', () =>
    request(app).post('/v1/fragments').send('hello').expect(401));

  test('incorrect credentials are denied', () =>
    request(app)
      .post('/v1/fragments')
      .auth('invalid@email.com', 'wrongpassword')
      .send('hello')
      .expect(401));

  test('authenticated users can create a plain text fragment', async () => {
    const res = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/plain')
      .send('This is a fragment');

    expect(res.statusCode).toBe(201);
    expect(res.body.status).toBe('ok');
    expect(res.body.fragment).toHaveProperty('id');
    expect(res.body.fragment).toHaveProperty('created');
    expect(res.body.fragment).toHaveProperty('updated');
    expect(res.body.fragment.type).toBe('text/plain');
    expect(res.body.fragment.size).toBe(18);
  });

  test('response includes a Location header with the fragment URL', async () => {
    const res = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/plain')
      .send('hello');

    expect(res.headers.location).toContain(`/v1/fragments/${res.body.fragment.id}`);
  });

  test('fragment ownerId matches the authenticated user', async () => {
    const res = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/plain')
      .send('hello');

    // ownerId should be a sha256 hash (64 hex chars), not a raw email
    expect(res.body.fragment.ownerId).toMatch(/^[0-9a-f]{64}$/);
  });

  test('unsupported Content-Type returns 415', () =>
    request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'application/msword')
      .send('nope')
      .expect(415));

  test('authenticated users can create a JSON fragment', async () => {
    const res = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ hello: 'world' }));

    expect(res.statusCode).toBe(201);
    expect(res.body.fragment.type).toBe('application/json');
  });

  test('authenticated users can create a text/markdown fragment', async () => {
    const res = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/markdown')
      .send('# Hello');

    expect(res.statusCode).toBe(201);
    expect(res.body.fragment.type).toBe('text/markdown');
  });

  test('authenticated users can create an application/yaml fragment', async () => {
    const res = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'application/yaml')
      .send('hello: world');

    expect(res.statusCode).toBe(201);
    expect(res.body.fragment.type).toBe('application/yaml');
  });

  describe.each(['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif'])(
    '%s fragments',
    (type) => {
      test(`authenticated users can create a ${type} fragment`, async () => {
        const data = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
        const res = await request(app)
          .post('/v1/fragments')
          .auth('test-user1@fragments-testing.com', 'test-password1')
          .set('Content-Type', type)
          .send(data);

        expect(res.statusCode).toBe(201);
        expect(res.body.fragment.type).toBe(type);
        expect(res.body.fragment.size).toBe(data.length);
      });
    }
  );
});
