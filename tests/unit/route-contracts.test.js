// tests/unit/route-contracts.test.js

// What the fragment routes promise beyond "200 or 404": the exact numeric
// limits (1 and the maximum are allowed, one past is not), the error messages
// clients read, the Location header, the Content-Type rules, and when a
// conversion is timed. Gaps found by mutation testing (docs/mutation/).

jest.mock('../../src/metrics', () => ({
  ...jest.requireActual('../../src/metrics'),
  timeConversion: jest.fn((_type, fn) => fn()),
}));

const request = require('supertest');
const sharp = require('sharp');
const app = require('../../src/app');
const { Fragment } = require('../../src/model/fragment');
const { timeConversion } = require('../../src/metrics');

const user1 = ['test-user1@fragments-testing.com', 'test-password1'];

const post = (type, body, query = '') =>
  request(app)
    .post(`/v1/fragments${query}`)
    .auth(...user1)
    .set('Content-Type', type)
    .send(body);
const get = (path) =>
  request(app)
    .get(path)
    .auth(...user1);

const png = (width = 8, height = 8) =>
  sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();

const errorOf = (res) => res.body.error;

beforeEach(() => timeConversion.mockClear());
afterEach(() => jest.restoreAllMocks());

describe('POST /v1/fragments', () => {
  test('?expiresIn: 1 second and exactly 30 days are allowed', async () => {
    expect((await post('text/plain', 'x', '?expiresIn=1')).statusCode).toBe(201);
    const max = 30 * 24 * 60 * 60;
    const res = await post('text/plain', 'x', `?expiresIn=${max}`);
    expect(res.statusCode).toBe(201);
    expect(res.body.fragment.expiresAt - Math.floor(Date.now() / 1000)).toBeGreaterThan(max - 5);
  });

  test.each([['0'], ['-1'], ['2592001'], ['1.5'], ['abc'], ['']])(
    '?expiresIn=%p is rejected with the allowed range in the message',
    async (value) => {
      const res = await post('text/plain', 'x', `?expiresIn=${value}`);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res)).toEqual({
        code: 400,
        message: 'expiresIn must be a whole number of seconds (1-2592000)',
      });
    }
  );

  test('an unsupported Content-Type is 415 with a message', async () => {
    const res = await post('video/mp4', 'x');
    expect(res.statusCode).toBe(415);
    expect(errorOf(res)).toEqual({ code: 415, message: 'Unsupported Content-Type' });
  });

  test('a Content-Type that is not even well formed is 415, not a server error', async () => {
    const res = await request(app)
      .post('/v1/fragments')
      .auth(...user1)
      .set('Content-Type', 'garbage')
      .send('x');
    expect(res.statusCode).toBe(415);
  });

  test('a body with no Content-Type at all is 415 too', async () => {
    const res = await request(app)
      .post('/v1/fragments')
      .auth(...user1)
      .send('plain');
    // supertest sends strings as form data by default: not one of ours
    expect(res.statusCode).toBe(415);
  });

  describe('the Location header', () => {
    afterEach(() => delete process.env.API_URL);

    test('is built from API_URL when it is set', async () => {
      process.env.API_URL = 'http://api.example.test';
      const res = await post('text/plain', 'x');
      expect(res.headers.location).toBe(
        `http://api.example.test/v1/fragments/${res.body.fragment.id}`
      );
    });

    test('falls back to the host the request came to', async () => {
      delete process.env.API_URL;
      const res = await post('text/plain', 'x');
      expect(res.headers.location).toMatch(
        new RegExp(`^http://127\\.0\\.0\\.1:\\d+/v1/fragments/${res.body.fragment.id}$`)
      );
    });
  });

  test('a storage failure is a 500 with a message', async () => {
    jest.spyOn(Fragment.prototype, 'save').mockRejectedValueOnce(new Error('db down'));
    const res = await post('text/plain', 'x');
    expect(res.statusCode).toBe(500);
    expect(errorOf(res)).toEqual({ code: 500, message: 'Unable to create fragment' });
  });

  test('a gzip-compressed body is decompressed before it is stored', async () => {
    const zlib = require('zlib');
    const res = await request(app)
      .post('/v1/fragments')
      .auth(...user1)
      .set('Content-Type', 'text/plain')
      .set('Content-Encoding', 'gzip')
      .send(zlib.gzipSync('compressed on the wire'));
    expect(res.statusCode).toBe(201);
    expect(res.body.fragment.size).toBe('compressed on the wire'.length);
  });
});

describe('GET /v1/fragments', () => {
  test('a failure is a 500 with a message', async () => {
    jest.spyOn(Fragment, 'byUser').mockRejectedValueOnce(new Error('db down'));
    const res = await get('/v1/fragments');
    expect(res.statusCode).toBe(500);
    expect(errorOf(res)).toEqual({ code: 500, message: 'Unable to list fragments' });
  });
});

describe('GET /v1/fragments/:id', () => {
  test('an unknown id is 404 with a message', async () => {
    const res = await get('/v1/fragments/nope');
    expect(res.statusCode).toBe(404);
    expect(errorOf(res)).toEqual({ code: 404, message: 'Fragment not found' });
  });

  describe('?width', () => {
    let id;
    beforeAll(async () => {
      id = (await post('image/png', await png())).body.fragment.id;
    });
    const widthOf = async (res) => (await sharp(res.body).metadata()).width;

    test('1 and 4096 are the smallest and largest allowed', async () => {
      const small = await get(`/v1/fragments/${id}?width=1`);
      expect(small.statusCode).toBe(200);
      expect(await widthOf(small)).toBe(1);
      // asking for more than the image has never enlarges it
      const large = await get(`/v1/fragments/${id}?width=4096`);
      expect(large.statusCode).toBe(200);
      expect(await widthOf(large)).toBe(8);
    });

    test.each([['0'], ['-5'], ['4097'], ['1.5'], ['abc'], ['']])(
      '%p is refused with the range in the message',
      async (value) => {
        const res = await get(`/v1/fragments/${id}?width=${value}`);
        expect(res.statusCode).toBe(400);
        expect(errorOf(res)).toEqual({
          code: 400,
          message: 'width must be a whole number of pixels (1-4096)',
        });
      }
    );

    test('is refused for something that is not an image', async () => {
      const text = (await post('text/plain', 'x')).body.fragment.id;
      const res = await get(`/v1/fragments/${text}?width=10`);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).message).toBe('width only applies to images');
    });

    test('a corrupt image that cannot be resized is a 500 with a message', async () => {
      const bad = (await post('image/png', Buffer.from('not an image'))).body.fragment.id;
      const res = await get(`/v1/fragments/${bad}?width=10`);
      expect(res.statusCode).toBe(500);
      // the error is JSON, not labelled as the image it failed to resize
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(errorOf(res)).toEqual({ code: 500, message: 'Unable to resize fragment' });
    });
  });

  describe('.ext conversions', () => {
    test('an unsupported conversion is 415 and names both sides', async () => {
      const id = (await post('text/plain', 'x')).body.fragment.id;
      const res = await get(`/v1/fragments/${id}.avif`);
      expect(res.statusCode).toBe(415);
      expect(errorOf(res)).toEqual({ code: 415, message: 'Cannot convert text/plain to .avif' });
    });

    test('an unknown extension is 415', async () => {
      const id = (await post('text/plain', 'x')).body.fragment.id;
      expect((await get(`/v1/fragments/${id}.xyz`)).statusCode).toBe(415);
    });

    test('a conversion that fails is a 500 with a message', async () => {
      const id = (await post('application/json', '{not json')).body.fragment.id;
      const res = await get(`/v1/fragments/${id}.yaml`);
      expect(res.statusCode).toBe(500);
      expect(errorOf(res)).toEqual({ code: 500, message: 'Unable to convert fragment' });
    });

    test('a pair that is allowed on paper but has no converter is 415, not an empty 200', async () => {
      // text/html lists text/plain, which works; force a type whose list allows something the converter cannot do
      jest
        .spyOn(Fragment.prototype, 'formats', 'get')
        .mockReturnValue(['text/markdown', 'image/png']);
      const id = (await post('text/markdown', '# x')).body.fragment.id;
      const res = await get(`/v1/fragments/${id}.png`);
      expect(res.statusCode).toBe(415);
      expect(errorOf(res).message).toBe('Cannot convert text/markdown to .png');
    });

    test("converting to the fragment's own type keeps its full Content-Type, charset included", async () => {
      const id = (await post('text/plain; charset=utf-8', 'héllo')).body.fragment.id;
      const res = await get(`/v1/fragments/${id}.txt`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    });

    test('a CSV fragment can be asked for as .csv (its own type) and as .json', async () => {
      const id = (await post('text/csv', 'a,b\n1,2')).body.fragment.id;
      const same = await get(`/v1/fragments/${id}.csv`);
      expect(same.statusCode).toBe(200);
      expect(same.headers['content-type']).toMatch(/^text\/csv/);
      expect((await get(`/v1/fragments/${id}.json`)).statusCode).toBe(200);
    });

    test('a real conversion answers with the target type', async () => {
      const id = (await post('text/markdown', '# x')).body.fragment.id;
      const res = await get(`/v1/fragments/${id}.html`);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
    });
  });

  describe('conversion timing (the ConversionDuration metric)', () => {
    test('a plain read is not a conversion and is not timed', async () => {
      const id = (await post('text/plain', 'x')).body.fragment.id;
      await get(`/v1/fragments/${id}`);
      expect(timeConversion).not.toHaveBeenCalled();
    });

    test('"converting" to the same type without a width is not timed either', async () => {
      const id = (await post('text/plain', 'x')).body.fragment.id;
      await get(`/v1/fragments/${id}.txt`);
      expect(timeConversion).not.toHaveBeenCalled();
    });

    test('a real conversion is timed under its target type', async () => {
      const id = (await post('text/markdown', '# x')).body.fragment.id;
      await get(`/v1/fragments/${id}.html`);
      expect(timeConversion).toHaveBeenCalledTimes(1);
      expect(timeConversion.mock.calls[0][0]).toBe('text/html');
    });

    test('resizing an image is timed, with or without an extension', async () => {
      const id = (await post('image/png', await png())).body.fragment.id;
      await get(`/v1/fragments/${id}?width=4`);
      await get(`/v1/fragments/${id}.png?width=4`);
      expect(timeConversion.mock.calls.map((c) => c[0])).toEqual(['image/png', 'image/png']);
    });
  });
});

describe('GET /v1/fragments/:id/info', () => {
  test('an unknown id is 404 with a message', async () => {
    const res = await get('/v1/fragments/nope/info');
    expect(res.statusCode).toBe(404);
    expect(errorOf(res)).toEqual({ code: 404, message: 'Fragment not found' });
  });
});

describe('DELETE /v1/fragments/:id', () => {
  test('an unknown id is 404 with a message', async () => {
    const res = await request(app)
      .delete('/v1/fragments/nope')
      .auth(...user1);
    expect(res.statusCode).toBe(404);
    expect(errorOf(res)).toEqual({ code: 404, message: 'Fragment not found' });
  });
});

describe('PUT /v1/fragments/:id', () => {
  const put = (id, type, body) => {
    const r = request(app)
      .put(`/v1/fragments/${id}`)
      .auth(...user1);
    if (type) r.set('Content-Type', type);
    return body === undefined ? r : r.send(body);
  };

  test('an unknown id is 404 with a message', async () => {
    const res = await put('nope', 'text/plain', 'x');
    expect(res.statusCode).toBe(404);
    expect(errorOf(res)).toEqual({ code: 404, message: 'Fragment not found' });
  });

  test('a body with a different type is refused: the type cannot change', async () => {
    const id = (await post('text/plain', 'x')).body.fragment.id;
    const res = await put(id, 'text/markdown', '# x');
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).message).toBe("A fragment's type cannot be changed after it is created");
  });

  test('a body of the same type but different charset is accepted', async () => {
    const id = (await post('text/plain; charset=utf-8', 'x')).body.fragment.id;
    expect((await put(id, 'text/plain; charset=iso-8859-1', 'y')).statusCode).toBe(200);
  });

  test('a request with no body empties the fragment (it is not an error)', async () => {
    const id = (await post('text/plain', 'x')).body.fragment.id;
    const res = await put(id, 'text/plain');
    expect(res.statusCode).toBe(200);
    expect(res.body.fragment.size).toBe(0);
  });

  test('a storage failure is a 500 with a message', async () => {
    const id = (await post('text/plain', 'x')).body.fragment.id;
    jest.spyOn(Fragment.prototype, 'setData').mockRejectedValueOnce(new Error('db down'));
    const res = await put(id, 'text/plain', 'y');
    expect(res.statusCode).toBe(500);
    expect(errorOf(res)).toEqual({ code: 500, message: 'Unable to update fragment' });
  });
});

describe('GET /v1/fragments/:id/share', () => {
  const share = (id, query = '') => get(`/v1/fragments/${id}/share${query}`);
  let id;
  beforeAll(async () => {
    id = (await post('text/plain', 'x')).body.fragment.id;
  });

  test('an unknown id is 404 with a message', async () => {
    const res = await share('nope');
    expect(res.statusCode).toBe(404);
    expect(errorOf(res)).toEqual({ code: 404, message: 'Fragment not found' });
  });

  test.each([['0'], ['-1'], ['3601'], ['1.5'], ['abc']])(
    '?expiresIn=%p is refused with the range in the message',
    async (value) => {
      const res = await share(id, `?expiresIn=${value}`);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).message).toBe('expiresIn must be a whole number of seconds (1-3600)');
    }
  );

  test('1 and 3600 seconds pass validation (memory mode then answers 501: no S3 to link to)', async () => {
    for (const ok of ['1', '3600']) {
      const res = await share(id, `?expiresIn=${ok}`);
      expect(res.statusCode).toBe(501);
    }
  });

  test('without S3 the answer is 501 and says why', async () => {
    const res = await share(id);
    expect(res.statusCode).toBe(501);
    expect(errorOf(res)).toEqual({
      code: 501,
      message: 'Share links need S3 storage (not available in memory mode)',
    });
  });

  test('an unexpected failure is a 500 with a message', async () => {
    jest.spyOn(Fragment.prototype, 'createShareLink').mockRejectedValueOnce(new Error('boom'));
    const res = await share(id);
    expect(res.statusCode).toBe(500);
    expect(errorOf(res)).toEqual({ code: 500, message: 'Unable to create share link' });
  });
});
