// tests/unit/convert-fragment.test.js

// convertFragment() is the single conversion entry point, used by the request
// handler (and later by a queue worker), so it is tested directly here too.

const sharp = require('sharp');
const { convertFragment, extToType, imageTypes, PDF, DOCX } = require('../../src/convert');

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
