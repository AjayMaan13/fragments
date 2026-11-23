// tests/unit/convert-fragment.test.js

// convertFragment() is the single conversion entry point, used by the request
// handler (and later by a queue worker), so it is tested directly here too.

const sharp = require('sharp');
const {
  convertFragment,
  ConversionLimitError,
  extToType,
  imageTypes,
  PDF,
  DOCX,
} = require('../../src/convert');

const makePng = (width, height) =>
  sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();

describe('convertFragment()', () => {
  test('same type returns the data untouched', async () => {
    const data = Buffer.from('hello');
    expect(await convertFragment(data, 'text/plain', 'text/plain')).toBe(data);
  });

  test('markdown -> html', async () => {
    const out = await convertFragment(Buffer.from('# Title'), 'text/markdown', 'text/html');
    expect(out).toContain('<h1>Title</h1>');
  });

  test('json -> yaml', async () => {
    const out = await convertFragment(
      Buffer.from('{"a":1}'),
      'application/json',
      'application/yaml'
    );
    expect(out).toBe('a: 1\n');
  });

  test('invalid json -> yaml throws', async () => {
    await expect(
      convertFragment(Buffer.from('{nope'), 'application/json', 'application/yaml')
    ).rejects.toThrow();
  });

  test('csv -> json', async () => {
    const out = await convertFragment(Buffer.from('a,b\n1,2\n'), 'text/csv', 'application/json');
    expect(JSON.parse(out)).toEqual([{ a: '1', b: '2' }]);
  });

  test('xml -> json and json -> xml', async () => {
    const json = await convertFragment(
      Buffer.from('<a><b>1</b></a>'),
      'application/xml',
      'application/json'
    );
    expect(JSON.parse(json)).toEqual({ a: { b: 1 } });
    const xml = await convertFragment(
      Buffer.from('{"a":{"b":1}}'),
      'application/json',
      'application/xml'
    );
    expect(xml).toContain('<b>1</b>');
  });

  test('markdown -> pdf and docx produce the right file signatures', async () => {
    const pdf = await convertFragment(Buffer.from('# Hi'), 'text/markdown', PDF);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    const docx = await convertFragment(Buffer.from('# Hi'), 'text/markdown', DOCX);
    expect(docx.subarray(0, 2).toString()).toBe('PK');
  });

  test('image -> image changes the format', async () => {
    const out = await convertFragment(await makePng(20, 10), 'image/png', 'image/webp');
    expect((await sharp(out).metadata()).format).toBe('webp');
  });

  test('image -> image with width shrinks it, keeping the aspect ratio', async () => {
    const out = await convertFragment(await makePng(40, 20), 'image/png', 'image/jpeg', {
      width: 10,
    });
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([10, 5]);
  });

  test('width never enlarges an image', async () => {
    const out = await convertFragment(await makePng(8, 8), 'image/png', 'image/png', {
      width: 100,
    });
    expect((await sharp(out).metadata()).width).toBe(8);
  });

  test('same image type with width resizes; without width returns the same bytes', async () => {
    const png = await makePng(40, 40);
    expect(await convertFragment(png, 'image/png', 'image/png')).toBe(png);
    const small = await convertFragment(png, 'image/png', 'image/png', { width: 20 });
    expect((await sharp(small).metadata()).width).toBe(20);
  });

  test('text-ish type -> text/plain falls back to the raw data', async () => {
    const data = Buffer.from('a,b\n1,2');
    expect(await convertFragment(data, 'text/csv', 'text/plain')).toBe(data);
  });

  test('an unsupported pair resolves to undefined', async () => {
    expect(await convertFragment(Buffer.from('x'), 'text/plain', 'image/png')).toBeUndefined();
  });

  test('a corrupt image throws', async () => {
    await expect(
      convertFragment(Buffer.from('not an image'), 'image/png', 'image/webp')
    ).rejects.toThrow();
  });
});

describe('extToType / imageTypes', () => {
  test('every image extension maps to an image type', () => {
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif']) {
      expect(imageTypes).toContain(extToType[ext]);
    }
  });

  test('.yml and .yaml are the same type', () => {
    expect(extToType['.yml']).toBe(extToType['.yaml']);
  });
});

describe('image safety limits', () => {
  afterEach(() => {
    delete process.env.MAX_IMAGE_PIXELS;
    delete process.env.MAX_CONCURRENT_IMAGE_CONVERSIONS;
  });

  test('an image over the pixel limit is refused with a 422 before it is decoded', async () => {
    process.env.MAX_IMAGE_PIXELS = '1000';
    const err = await convertFragment(await makePng(40, 40), 'image/png', 'image/webp').catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(ConversionLimitError);
    expect(err.status).toBe(422);
    expect(err.retryAfter).toBeUndefined();
    expect(err.message).toContain('40x40');
    expect(err.message).toContain('0.001 megapixels');
  });

  test('an image exactly at the limit is converted; one pixel over is refused', async () => {
    process.env.MAX_IMAGE_PIXELS = '400';
    await expect(
      convertFragment(await makePng(20, 20), 'image/png', 'image/webp')
    ).resolves.toBeTruthy();
    await expect(convertFragment(await makePng(21, 20), 'image/png', 'image/webp')).rejects.toThrow(
      ConversionLimitError
    );
  });

  test('the limit also applies when only resizing (same type, with width)', async () => {
    process.env.MAX_IMAGE_PIXELS = '1000';
    await expect(
      convertFragment(await makePng(40, 40), 'image/png', 'image/png', { width: 10 })
    ).rejects.toThrow(ConversionLimitError);
  });

  test('a 25-megapixel image is refused with the default limit', async () => {
    // 5000x5000 solid colour: tiny on disk, big once decoded (the shape of the production crash)
    const big = await makePng(5000, 5000);
    expect(big.length).toBeLessThan(1024 * 1024);
    const err = await convertFragment(big, 'image/png', 'image/avif').catch((e) => e);
    expect(err).toBeInstanceOf(ConversionLimitError);
    expect(err.status).toBe(422);
  });

  test('extra image conversions beyond the in-flight limit get a 503 and a retry hint', async () => {
    process.env.MAX_CONCURRENT_IMAGE_CONVERSIONS = '1';
    const png = await makePng(300, 300);
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => convertFragment(png, 'image/png', 'image/webp'))
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((r) => r.status === 'rejected');
    expect(refused).toHaveLength(2);
    for (const { reason } of refused) {
      expect(reason).toBeInstanceOf(ConversionLimitError);
      expect(reason.status).toBe(503);
      expect(reason.retryAfter).toBe(5);
    }
  });

  test('the in-flight slot is released after success and after a failure', async () => {
    process.env.MAX_CONCURRENT_IMAGE_CONVERSIONS = '1';
    await expect(
      convertFragment(Buffer.from('not an image'), 'image/png', 'image/webp')
    ).rejects.toThrow();
    await expect(
      convertFragment(await makePng(10, 10), 'image/png', 'image/webp')
    ).resolves.toBeTruthy();
    await expect(
      convertFragment(await makePng(10, 10), 'image/png', 'image/webp')
    ).resolves.toBeTruthy();
  });

  test('non-image conversions are not subject to the image limit', async () => {
    process.env.MAX_CONCURRENT_IMAGE_CONVERSIONS = '1';
    const results = await Promise.all(
      [1, 2, 3].map(() => convertFragment(Buffer.from('# hi'), 'text/markdown', 'text/html'))
    );
    expect(results).toHaveLength(3);
  });
});

describe('more image and limit details', () => {
  const zlib = require('zlib');
  afterEach(() => {
    delete process.env.MAX_IMAGE_PIXELS;
    delete process.env.MAX_CONCURRENT_IMAGE_CONVERSIONS;
  });

  // A 66-byte PNG whose header claims 30000x30000 pixels: no real pixel data
  // exists, but the size check only reads the header
  const hugeHeaderPng = () => {
    const chunk = (type, data) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(zlib.crc32(body) >>> 0);
      return Buffer.concat([len, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(30000, 0);
    header.writeUInt32BE(30000, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', zlib.deflateSync(Buffer.alloc(1))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  };

  test("an image bigger than even sharp will look at gets our friendly 422, not sharp's own error", async () => {
    const err = await convertFragment(hugeHeaderPng(), 'image/png', 'image/webp').catch((e) => e);
    expect(err).toBeInstanceOf(ConversionLimitError);
    expect(err.status).toBe(422);
    expect(err.message).toContain('30000x30000');
    expect(err.message).toContain('16 megapixels');
  });

  test('the error carries its own name', async () => {
    const err = await convertFragment(hugeHeaderPng(), 'image/png', 'image/webp').catch((e) => e);
    expect(err.name).toBe('ConversionLimitError');
  });

  test('by default two image conversions may run at once; the third is turned away', async () => {
    const png = await makePng(300, 300);
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => convertFragment(png, 'image/png', 'image/webp'))
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const [refused] = results.filter((r) => r.status === 'rejected');
    expect(refused.reason.status).toBe(503);
  });

  test('every image type is a real conversion target, with the right format', async () => {
    const png = await makePng(10, 10);
    for (const [type, format] of [
      ['image/png', 'png'],
      ['image/jpeg', 'jpeg'],
      ['image/webp', 'webp'],
      ['image/avif', 'heif'],
      ['image/gif', 'gif'],
    ]) {
      const out = await convertFragment(png, 'image/png', type);
      expect((await sharp(out).metadata()).format).toBe(format);
    }
  });

  test('every extension maps to its own type', () => {
    const { extToType: map } = require('../../src/convert');
    expect(map).toMatchObject({
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.html': 'text/html',
      '.csv': 'text/csv',
      '.json': 'application/json',
      '.yaml': 'application/yaml',
      '.yml': 'application/yaml',
      '.xml': 'application/xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.avif': 'image/avif',
      '.gif': 'image/gif',
    });
  });
});
