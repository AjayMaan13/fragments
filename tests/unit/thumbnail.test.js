// Unit tests for image resizing: GET /v1/fragments/:id[.ext]?width=<pixels>

const request = require('supertest');
const sharp = require('sharp');
const app = require('../../src/app');

const auth = ['test-user1@fragments-testing.com', 'test-password1'];

// A 200x100 solid-colour PNG, generated so no fixture file is needed
const makePng = () =>
  sharp({ create: { width: 200, height: 100, channels: 3, background: '#ff0000' } })
    .png()
    .toBuffer();

const createImage = async () => {
  const res = await request(app)
    .post('/v1/fragments')
    .auth(...auth)
    .set('Content-Type', 'image/png')
    .send(await makePng());
  return res.body.fragment.id;
};

const read = (id, ext = '', query = '') =>
  request(app)
    .get(`/v1/fragments/${id}${ext}${query}`)
    .auth(...auth)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

const viewsOf = async (id) =>
  (
    await request(app)
      .get(`/v1/fragments/${id}/info`)
      .auth(...auth)
  ).body.fragment.viewCount;

describe('image resizing with ?width=', () => {
  test('without width the image is returned unchanged', async () => {
    const id = await createImage();
    const res = await read(id);
    expect(res.body.equals(await makePng())).toBe(true);
  });

  test('shrinks the raw image and keeps its aspect ratio and type', async () => {
    const id = await createImage();

    const res = await read(id, '', '?width=50');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    const meta = await sharp(res.body).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(25);
  });

  test('never enlarges an image beyond its original size', async () => {
    const id = await createImage();

    const res = await read(id, '', '?width=1000');

    expect((await sharp(res.body).metadata()).width).toBe(200);
  });

  test('can convert format and resize in one request', async () => {
    const id = await createImage();

    const res = await read(id, '.webp', '?width=80');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/webp');
    const meta = await sharp(res.body).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(80);
  });

  test('resizes when the extension matches the fragment own type', async () => {
    const id = await createImage();

    const res = await read(id, '.png', '?width=40');

    expect(res.headers['content-type']).toContain('image/png');
    expect((await sharp(res.body).metadata()).width).toBe(40);
  });

  test.each(['abc', '0', '-5', '1.5', '', '4097'])(
    'invalid width=%p returns 400 and does not count as a view',
    async (value) => {
      const id = await createImage();

      const res = await request(app)
        .get(`/v1/fragments/${id}?width=${value}`)
        .auth(...auth);

      expect(res.statusCode).toBe(400);
      expect(await viewsOf(id)).toBe(0);
    }
  );

  test('width on a non-image fragment returns 400', async () => {
    const post = await request(app)
      .post('/v1/fragments')
      .auth(...auth)
      .set('Content-Type', 'text/plain')
      .send('not an image');

    const res = await request(app)
      .get(`/v1/fragments/${post.body.fragment.id}?width=50`)
      .auth(...auth);

    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toMatch(/images/);
  });

  test('a corrupt image that cannot be resized returns 500', async () => {
    const post = await request(app)
      .post('/v1/fragments')
      .auth(...auth)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('this is not a png'));

    const res = await request(app)
      .get(`/v1/fragments/${post.body.fragment.id}?width=50`)
      .auth(...auth);

    expect(res.statusCode).toBe(500);
  });

  test('a resized read counts as one view', async () => {
    const id = await createImage();

    await read(id, '', '?width=50');

    expect(await viewsOf(id)).toBe(1);
  });
});
