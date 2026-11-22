// tests/unit/request-id.test.js

const request = require('supertest');
const app = require('../../src/app');
const { genReqId } = require('../../src/request-id');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('X-Request-Id', () => {
  test('is generated and returned when the caller sends none', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  test('an incoming id is honored and echoed back', async () => {
    const res = await request(app).get('/').set('X-Request-Id', 'trace-123.abc_DEF');
    expect(res.headers['x-request-id']).toBe('trace-123.abc_DEF');
  });

  test('is also returned on error responses', async () => {
    const res = await request(app).get('/no-such-route').set('X-Request-Id', 'abc');
    expect(res.status).toBe(404);
    expect(res.headers['x-request-id']).toBe('abc');
  });

  test('two requests without ids get different ids', async () => {
    const a = await request(app).get('/');
    const b = await request(app).get('/');
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });
});

describe('genReqId()', () => {
  const run = (value) => {
    const headers = {};
    const res = { setHeader: (k, v) => (headers[k] = v) };
    const id = genReqId({ headers: value === undefined ? {} : { 'x-request-id': value } }, res);
    return { id, headers };
  };

  test.each([
    ['empty string', ''],
    ['too long (129 chars)', 'a'.repeat(129)],
    ['has a space', 'bad id'],
    ['has a newline (log injection)', 'abc\nINJECTED'],
    ['has a quote', 'a"b'],
    ['not a string', ['a', 'b']],
  ])('replaces an unsafe id: %s', (_name, value) => {
    const { id, headers } = run(value);
    expect(id).toMatch(UUID);
    expect(headers['X-Request-Id']).toBe(id);
  });

  test('accepts an id of exactly 128 safe characters', () => {
    const value = 'a'.repeat(128);
    expect(run(value).id).toBe(value);
  });
});
