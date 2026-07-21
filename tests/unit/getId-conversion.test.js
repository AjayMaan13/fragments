// Unit tests for GET /v1/fragments/:id.ext conversions

const request = require('supertest');
const yaml = require('js-yaml');
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
      .get(`/v1/fragments/${id}.pdf`)
      .auth('test-user1@fragments-testing.com', 'test-password1');

    expect(res.statusCode).toBe(415);
  });

  test('a known extension not supported by the source type returns 415', async () => {
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

  test('json fragment can be converted to .yaml', async () => {
    const post = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ hello: 'world', n: 1 }));
    const { id } = post.body.fragment;

    const res = await request(app)
      .get(`/v1/fragments/${id}.yaml`)
      .auth('test-user1@fragments-testing.com', 'test-password1');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/yaml');
    expect(res.text).toContain('hello: world');
    expect(yaml.load(res.text)).toEqual({ hello: 'world', n: 1 });
  });

  test('csv fragment can be converted to .json', async () => {
    const post = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'text/csv')
      .send('name,age\nalice,30\nbob,25');
    const { id } = post.body.fragment;

    const res = await request(app)
      .get(`/v1/fragments/${id}.json`)
      .auth('test-user1@fragments-testing.com', 'test-password1');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.text)).toEqual([
      { name: 'alice', age: '30' },
      { name: 'bob', age: '25' },
    ]);
  });

  test('image fragment can be converted to a different image format', async () => {
    // A valid 1x1 PNG, base64-encoded, so sharp can actually decode it
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    );

    const post = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'image/png')
      .send(png);
    const { id } = post.body.fragment;

    const res = await request(app)
      .get(`/v1/fragments/${id}.jpg`)
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    // JPEG files start with the bytes FF D8
    expect(res.body[0]).toBe(0xff);
    expect(res.body[1]).toBe(0xd8);
  });

  test('image fragment cannot be converted to .txt (415)', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    );

    const post = await request(app)
      .post('/v1/fragments')
      .auth('test-user1@fragments-testing.com', 'test-password1')
      .set('Content-Type', 'image/png')
      .send(png);
    const { id } = post.body.fragment;

    const res = await request(app)
      .get(`/v1/fragments/${id}.txt`)
      .auth('test-user1@fragments-testing.com', 'test-password1');

    expect(res.statusCode).toBe(415);
  });
});
