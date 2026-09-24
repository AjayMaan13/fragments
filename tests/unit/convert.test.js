// Unit tests for XML <-> JSON and markdown/text -> PDF/DOCX conversions

const zlib = require('zlib');
const request = require('supertest');
const JSZip = require('jszip');
const app = require('../../src/app');
const { PDF, DOCX } = require('../../src/convert');

const auth = ['test-user1@fragments-testing.com', 'test-password1'];

const create = async (type, body) => {
  const res = await request(app)
    .post('/v1/fragments')
    .auth(...auth)
    .set('Content-Type', type)
    .send(body);
  return res.body.fragment.id;
};

// Binary responses arrive as a Buffer
const read = (id, ext) =>
  request(app)
    .get(`/v1/fragments/${id}${ext}`)
    .auth(...auth)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

// pdfkit writes each line's text as Windows-1252 hex strings inside compressed streams
const winAnsi = new TextDecoder('windows-1252');
const pdfText = (buffer) => {
  const streams = buffer.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g);
  let content = '';
  for (const [, body] of streams) {
    try {
      content += zlib.inflateSync(Buffer.from(body, 'latin1')).toString('latin1');
    } catch {
      // not a compressed content stream (fonts, images)
    }
  }
  return [...content.matchAll(/<([0-9a-f]+)>/g)]
    .map(([, hex]) => winAnsi.decode(Buffer.from(hex, 'hex')))
    .join('');
};

const docxXml = async (buffer) =>
  (await JSZip.loadAsync(buffer)).file('word/document.xml').async('string');

const MARKDOWN = '# Title\n\nSome text.\n\n- first item\n- second item\n\n```\ncode line\n```\n';

describe('XML <-> JSON', () => {
  test('xml converts to json, keeping attributes and repeated elements', async () => {
    const id = await create('application/xml', '<a id="1"><b>x</b><b>y</b></a>');

    const res = await request(app)
      .get(`/v1/fragments/${id}.json`)
      .auth(...auth);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.text)).toEqual({ a: { '@_id': '1', b: ['x', 'y'] } });
  });

  test('malformed xml cannot be converted', async () => {
    const id = await create('application/xml', '<a><b></a>');

    const res = await request(app)
      .get(`/v1/fragments/${id}.json`)
      .auth(...auth);

    expect(res.statusCode).toBe(500);
  });

  test('xml can also be read as plain text', async () => {
    const id = await create('application/xml', '<a>hi</a>');

    const res = await request(app)
      .get(`/v1/fragments/${id}.txt`)
      .auth(...auth);

    expect(res.text).toBe('<a>hi</a>');
  });

  test('json with a single key converts to xml using that key as the root', async () => {
    const id = await create('application/json', '{"note":{"to":"you"}}');

    const res = await request(app)
      .get(`/v1/fragments/${id}.xml`)
      .auth(...auth);

    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.text).toContain('<note>');
    expect(res.text).toContain('<to>you</to>');
  });

  test.each([
    ['several keys', '{"a":1,"b":2}'],
    ['an array', '[1,2]'],
    ['a plain value', '5'],
  ])('json that is %s is wrapped in a single <root> element', async (_, json) => {
    const id = await create('application/json', json);

    const res = await request(app)
      .get(`/v1/fragments/${id}.xml`)
      .auth(...auth);

    expect(res.text.trim().startsWith('<root>')).toBe(true);
    expect(res.text.trim().endsWith('</root>')).toBe(true);
  });
});

describe('markdown and text -> PDF', () => {
  test('markdown becomes a PDF containing its headings, paragraphs, list items and code', async () => {
    const id = await create('text/markdown', MARKDOWN);

    const res = await read(id, '.pdf');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(PDF);
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdfText(res.body);
    for (const expected of ['Title', 'Some text.', '• first item', '• second item', 'code line']) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain('#');
  });

  test('plain text becomes a PDF and is not parsed as markdown', async () => {
    const id = await create('text/plain', '# not a heading\nsecond line');

    const res = await read(id, '.pdf');

    expect(pdfText(res.body)).toContain('# not a heading');
    expect(pdfText(res.body)).toContain('second line');
  });
});

describe('markdown and text -> DOCX', () => {
  test('markdown becomes a Word file with real headings and bullets', async () => {
    const id = await create('text/markdown', MARKDOWN);

    const res = await read(id, '.docx');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(DOCX);
    const xml = await docxXml(res.body);
    for (const expected of ['Title', 'Some text.', 'first item', 'second item', 'code line']) {
      expect(xml).toContain(expected);
    }
    expect(xml).toContain('Heading1');
    expect(xml).toContain('<w:numPr>');
  });

  test('plain text becomes a Word file, one paragraph per line', async () => {
    const id = await create('text/plain', 'line one\nline two');

    const xml = await docxXml((await read(id, '.docx')).body);

    expect(xml).toContain('line one');
    expect(xml).toContain('line two');
  });
});

describe('unsupported combinations', () => {
  test.each([
    ['text/html', '.pdf'],
    ['application/json', '.docx'],
    ['text/csv', '.xml'],
    ['image/png', '.pdf'],
  ])('%s cannot be converted to %s', async (type, ext) => {
    const id = await create(type, 'x');

    const res = await request(app)
      .get(`/v1/fragments/${id}${ext}`)
      .auth(...auth);

    expect(res.statusCode).toBe(415);
  });

  test('PDF is an output format only: it cannot be stored as a fragment', async () => {
    const res = await request(app)
      .post('/v1/fragments')
      .auth(...auth)
      .set('Content-Type', PDF)
      .send('%PDF-1.3');

    expect(res.statusCode).toBe(415);
  });
});
