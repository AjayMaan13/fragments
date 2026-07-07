// Unit tests for GET /v1/fragments/:id.ext conversions

const request = require('supertest');
const app = require('../../src/app');

describe('GET /v1/fragments/:id.ext conversions', () => {
  test('markdown fragment can be retrieved as .html', async () => {
    const post = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/markdown')
      .send('# Hello');
    const { id } = post.body.fragment;

    const res = await request(app)
      .get(`/v1/fragments/${id}.html`)
      .auth('test-user1@fragments-testing.com', 'test-password1');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<h1>Hello</h1>');
  });

  test('markdown fragment can still be retrieved as .md (own type, no conversion)', async () => {
    const post = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/markdown')
      .send('# Hello');
    const { id } = post.body.fragment;

    const res = await request(app)
      .get(`/v1/fragments/${id}.md`)
      .auth('test-user1@fragments-testing.com', 'test-password1');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.text).toBe('# Hello');
  });

  test('json fragment can be retrieved as .txt fallback', async () => {
    const post = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ hello: 'world' }));
    const { id } = post.body.fragment;

    const res = await request(app)
      .get(`/v1/fragments/${id}.txt`)
      .auth('test-user1@fragments-testing.com', 'test-password1');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });

  test('unsupported conversion (.html on a plain text fragment) returns 415', async () => {
    const post = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/plain')
      .send('hello');
    const { id } = post.body.fragment;

    const res = await request(app)
      .get(`/v1/fragments/${id}.html`)
      .auth('test-user1@fragments-testing.com', 'test-password1');

    expect(res.statusCode).toBe(415);
  });

  test('unknown extension returns 415', async () => {
    const post = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/plain')
      .send('hello');
    const { id } = post.body.fragment;

    const res = await request(app)
      .get(`/v1/fragments/${id}.png`)
      .auth('test-user1@fragments-testing.com', 'test-password1');

    expect(res.statusCode).toBe(415);
  });
});
