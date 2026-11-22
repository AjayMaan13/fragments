// tests/unit/image-limits.test.js

// HTTP behaviour of the image safety limits (see src/convert.js): an image with
// too many pixels is answered with 422 (it used to be able to kill the server),
// and too many simultaneous image conversions get a 503 with Retry-After.

const request = require('supertest');
const sharp = require('sharp');
const app = require('../../src/app');

const auth = ['test-user1@fragments-testing.com', 'test-password1'];

const postImage = async (buffer) => {
  const res = await request(app)
    .post('/v1/fragments')
    .auth(...auth)
    .set('Content-Type', 'image/png')
    .send(buffer);
  expect(res.statusCode).toBe(201);
  return res.body.fragment.id;
};

describe('image safety limits over HTTP', () => {
  afterEach(() => {
    delete process.env.MAX_CONCURRENT_IMAGE_CONVERSIONS;
  });

  test('a huge-pixel image uploads fine but converting it answers 422', async () => {
    const big = await sharp({
      create: { width: 5000, height: 5000, channels: 3, background: '#3a6ea5' },
    })
      .png()
      .toBuffer();
    const id = await postImage(big);

    const res = await request(app)
      .get(`/v1/fragments/${id}.avif`)
      .auth(...auth);
    expect(res.statusCode).toBe(422);
    expect(res.body.status).toBe('error');
    expect(res.body.error.code).toBe(422);
    expect(res.body.error.message).toContain('too large');
    expect(res.headers['retry-after']).toBeUndefined();
  });

  test('resizing a huge-pixel image with ?width is refused too, but the raw bytes still download', async () => {
    const big = await sharp({
      create: { width: 5000, height: 5000, channels: 3, background: '#3a6ea5' },
    })
      .png()
      .toBuffer();
    const id = await postImage(big);

    const resized = await request(app)
      .get(`/v1/fragments/${id}?width=100`)
      .auth(...auth);
    expect(resized.statusCode).toBe(422);

    const raw = await request(app)
      .get(`/v1/fragments/${id}`)
      .auth(...auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(raw.statusCode).toBe(200);
    expect(raw.body.equals(big)).toBe(true);
  });

  test('an ordinary image still converts', async () => {
    const small = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    const id = await postImage(small);
    const res = await request(app)
      .get(`/v1/fragments/${id}.webp`)
      .auth(...auth);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/webp');
  });

  test('simultaneous image conversions beyond the limit get 503 with Retry-After', async () => {
    process.env.MAX_CONCURRENT_IMAGE_CONVERSIONS = '1';
    // Noise makes the avif encode slow enough that the requests overlap
    const noisy = await sharp({
      create: {
        width: 400,
        height: 400,
        channels: 3,
        background: '#808080',
        noise: { type: 'gaussian', mean: 128, sigma: 60 },
      },
    })
      .png()
      .toBuffer();
    const id = await postImage(noisy);

    const responses = await Promise.all(
      [1, 2, 3, 4].map(() =>
        request(app)
          .get(`/v1/fragments/${id}.avif`)
          .auth(...auth)
      )
    );
    const statuses = responses.map((r) => r.statusCode);
    expect(statuses.every((s) => s === 200 || s === 503)).toBe(true);
    expect(statuses).toContain(200);
    expect(statuses).toContain(503);

    const busy = responses.find((r) => r.statusCode === 503);
    expect(busy.headers['retry-after']).toBe('5');
    expect(busy.body.error.message).toContain('try again');
  });
});
