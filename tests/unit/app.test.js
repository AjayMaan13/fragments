// tests/unit/app.test.js

const request = require('supertest');

const app = require('../../src/app');

describe('404 handler', () => {
  test('should return HTTP 404 for unknown routes', async () => {
    const res = await request(app).get('/unknown-route');
    expect(res.statusCode).toBe(404);
  });

  test('should return error status in response body', async () => {
    const res = await request(app).get('/no-such-path');
    expect(res.body.status).toBe('error');
  });

  test('should return error code 404 in response body', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.body.error.code).toBe(404);
  });

  test('should return not found message in response body', async () => {
    const res = await request(app).get('/missing');
    expect(res.body.error.message).toBe('not found');
  });
});
