// tests/unit/convert-behaviour.test.js

// The details of src/convert.js that the route-level tests do not pin down:
// how markdown becomes blocks, how JSON becomes XML, what the PDF and Word
// output actually contain, and exactly which type pairs convert at all. These
// were found as gaps by mutation testing (Stryker), see docs/mutation/.

const zlib = require('zlib');
const JSZip = require('jszip');
const sharp = require('sharp');
const { convertFragment, convert, toBlocks, PDF, DOCX } = require('../../src/convert');

const buf = (s) => Buffer.from(s);

describe('toBlocks: plain text', () => {
  test('splits on LF and on CRLF', () => {
    expect(toBlocks(buf('a\nb'), 'text/plain')).toEqual([{ text: 'a' }, { text: 'b' }]);
    expect(toBlocks(buf('a\r\nb'), 'text/plain')).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  test('blank lines are kept as empty blocks', () => {
    expect(toBlocks(buf('a\n\nb'), 'text/plain')).toEqual([
      { text: 'a' },
      { text: '' },
      { text: 'b' },
    ]);
  });
});

describe('toBlocks: markdown', () => {
  test('a heading carries its level, and the level resets after it', () => {
    expect(toBlocks(buf('# Title\n\nbody\n\n### Sub'), 'text/markdown')).toEqual([
      { text: 'Title', level: 1, list: false },
      { text: 'body', level: 0, list: false },
      { text: 'Sub', level: 3, list: false },
    ]);
  });

  test('list items are marked as list, and text after the list is not', () => {
    expect(toBlocks(buf('- one\n- two\n\nafter'), 'text/markdown')).toEqual([
      { text: 'one', level: 0, list: true },
      { text: 'two', level: 0, list: true },
      { text: 'after', level: 0, list: false },
    ]);
  });

  test('nested lists are all list items, and the nesting is fully closed afterwards', () => {
    const blocks = toBlocks(buf('- a\n  - b\n- c\n\nafter'), 'text/markdown');
    expect(blocks.map((b) => [b.text, b.list])).toEqual([
      ['a', true],
      ['b', true],
      ['c', true],
      ['after', false],
    ]);
  });

  test('ordered lists count as lists too', () => {
    const blocks = toBlocks(buf('1. first\n2. second'), 'text/markdown');
    expect(blocks.every((b) => b.list)).toBe(true);
  });

  test('a fenced code block becomes one block per line, flagged as code, indentation kept', () => {
    const blocks = toBlocks(buf('```\nx\n  indented\n```'), 'text/markdown');
    expect(blocks).toEqual([
      { text: 'x', code: true },
      { text: '  indented', code: true },
    ]);
  });

  test('trailing blank lines in a fence do not become empty blocks', () => {
    const blocks = toBlocks(buf('```\nx\n\n\n```'), 'text/markdown');
    expect(blocks).toEqual([{ text: 'x', code: true }]);
  });

  test('an indented code block is code too', () => {
    expect(toBlocks(buf('para\n\n    code line'), 'text/markdown')).toEqual([
      { text: 'para', level: 0, list: false },
      { text: 'code line', code: true },
    ]);
  });

  test('a soft line break inside a paragraph is a space', () => {
    expect(toBlocks(buf('line one\nline two'), 'text/markdown')[0].text).toBe('line one line two');
  });

  test('inline formatting is flattened to its text', () => {
    expect(toBlocks(buf('**bold** and *em* and `code`'), 'text/markdown')[0].text).toBe(
      'bold and em and code'
    );
  });
});

// The text of every PDF content stream, so font sizes can be read back
const pdfStreams = (pdf) => {
  const raw = pdf.toString('latin1');
  const out = [];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      out.push(zlib.inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1'));
    } catch {
      /* not a compressed stream */
    }
  }
  return out.join('\n');
};
const fontSizes = (pdf) =>
  [...pdfStreams(pdf).matchAll(/\/F\d+ ([\d.]+) Tf/g)].map((m) => Number(m[1]));
const pageCount = (pdf) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;

describe('PDF output', () => {
  test('heading sizes shrink with the level but never below 12', async () => {
    const md = ['# a', '## b', '### c', '#### d', '##### e', '###### f'].join('\n\n');
    const pdf = await convert(buf(md), 'text/markdown', PDF);
    expect(fontSizes(pdf)).toEqual([23, 20, 17, 14, 12, 12]);
  });

  test('body text is 12 pt and code is 10 pt', async () => {
    const pdf = await convert(buf('plain\n\n```\ncode\n```'), 'text/markdown', PDF);
    expect(fontSizes(pdf)).toEqual([12, 10]);
  });

  test('headings use a bold font, code uses a monospaced one, plain text uses neither', async () => {
    const heading = (await convert(buf('# Title'), 'text/markdown', PDF)).toString('latin1');
    const code = (await convert(buf('```\nx\n```'), 'text/markdown', PDF)).toString('latin1');
    const plain = (await convert(buf('just text'), 'text/plain', PDF)).toString('latin1');

    expect(heading).toContain('Helvetica-Bold');
    expect(code).toContain('Courier');
    expect(plain).not.toContain('Helvetica-Bold');
    expect(plain).not.toContain('Courier');
  });

  test('paragraphs are spaced out, so the same lines need more pages than if they were packed', async () => {
    // 45 short paragraphs: with spacing they spill onto a second page, without it they would not
    const text = Array.from({ length: 45 }, (_, i) => `line ${i}`).join('\n');
    expect(pageCount(await convert(buf(text), 'text/plain', PDF))).toBe(2);
    // code lines are packed tightly (no spacing between them): 45 of them fit on one page
    const code = '```\n' + Array.from({ length: 45 }, (_, i) => `l${i}`).join('\n') + '\n```';
    expect(pageCount(await convert(buf(code), 'text/markdown', PDF))).toBe(1);
  });

  test('blank lines still take up a line each (40 of them overflow one page)', async () => {
    expect(pageCount(await convert(buf('\n'.repeat(40)), 'text/plain', PDF))).toBe(2);
    expect(pageCount(await convert(buf('\n'.repeat(20)), 'text/plain', PDF))).toBe(1);
  });

  test('a heading is set apart from what is above it', async () => {
    // 24 smallest-size headings need a second page only because of the space around each one
    const headings = (n) => Array.from({ length: n }, (_, i) => `###### h${i}`).join('\n\n');
    expect(pageCount(await convert(buf(headings(20)), 'text/markdown', PDF))).toBe(1);
    expect(pageCount(await convert(buf(headings(24)), 'text/markdown', PDF))).toBe(2);
  });

  test('bullets are drawn for list items', async () => {
    const withList = await convert(buf('- item'), 'text/markdown', PDF);
    const without = await convert(buf('item'), 'text/markdown', PDF);
    // the bullet character is an extra glyph in the content stream
    expect(pdfStreams(withList).length).toBeGreaterThan(pdfStreams(without).length);
  });
});

describe('Word output', () => {
  const documentXml = async (md, type = 'text/markdown') => {
    const zip = await JSZip.loadAsync(await convert(buf(md), type, DOCX));
    return zip.file('word/document.xml').async('string');
  };

  test('headings carry their level', async () => {
    const xml = await documentXml('# One\n\n## Two\n\nbody');
    expect(xml).toContain('w:val="Heading1"');
    expect(xml).toContain('w:val="Heading2"');
    expect(xml.match(/Heading\d/g)).toHaveLength(2); // the body paragraph has no heading style
  });

  test('list items are bulleted at level 0; other paragraphs are not', async () => {
    const xml = await documentXml('- one\n- two\n\nplain');
    expect(xml.match(/<w:numPr>/g)).toHaveLength(2);
    expect(xml).toContain('<w:ilvl w:val="0"/>');
  });

  test('code is set in Courier New and nothing else is', async () => {
    const xml = await documentXml('plain\n\n```\ncode\n```');
    // exactly one run (the code line) is monospaced
    expect(xml.match(/w:ascii="Courier New"/g)).toHaveLength(1);
    const plainOnly = await documentXml('just text', 'text/plain');
    expect(plainOnly).not.toContain('Courier New');
  });

  test('the text itself is all there', async () => {
    const xml = await documentXml('# Title\n\nsome words');
    expect(xml).toContain('Title');
    expect(xml).toContain('some words');
  });
});

describe('JSON to XML', () => {
  const toXml = async (json) =>
    (await convertFragment(buf(json), 'application/json', 'application/xml')).trim();

  test('an object with exactly one key uses that key as the root element', async () => {
    expect(await toXml('{"a":{"b":1}}')).toBe('<a>\n  <b>1</b>\n</a>');
  });

  test('an object with several keys is wrapped in <root>', async () => {
    expect(await toXml('{"a":1,"b":2}')).toBe('<root>\n  <a>1</a>\n  <b>2</b>\n</root>');
  });

  test('an empty object is wrapped in <root>', async () => {
    expect(await toXml('{}')).toContain('<root>');
  });

  test('an array is wrapped in <root>', async () => {
    const xml = await toXml('[1,2]');
    expect(xml).toContain('<root>');
    expect(xml.match(/<root>/g)).toHaveLength(2);
  });

  test('even a one-character string is wrapped (strings are not objects with one key)', async () => {
    expect(await toXml('"a"')).toContain('<root>a</root>');
  });

  test('scalars and null are wrapped in <root>', async () => {
    expect(await toXml('5')).toContain('<root>5</root>');
    expect(await toXml('"text"')).toContain('<root>text</root>');
    expect(await toXml('null')).toContain('<root');
  });

  test('keys starting with @_ become attributes', async () => {
    expect(await toXml('{"a":{"@_id":"7","b":1}}')).toBe('<a id="7">\n  <b>1</b>\n</a>');
  });

  test('the output is indented, not one long line', async () => {
    expect(await toXml('{"a":{"b":1}}')).toContain('\n');
  });
});

describe('XML to JSON', () => {
  test('attributes are kept under @_ names', async () => {
    const json = await convertFragment(
      buf('<a id="7"><b>1</b></a>'),
      'application/xml',
      'application/json'
    );
    expect(JSON.parse(json)).toEqual({ a: { '@_id': '7', b: 1 } });
  });

  test('malformed XML is refused instead of guessed at', async () => {
    await expect(
      convertFragment(buf('<a><b></a>'), 'application/xml', 'application/json')
    ).rejects.toThrow();
  });
});

// Every pair the API declares as convertible (Fragment#formats), plus same-type, plus anything to plain text.
// Everything else must come back undefined: no accidental conversions.
describe('which type pairs convert', () => {
  const samples = {
    'text/plain': 'hello',
    'text/markdown': '# hi',
    'text/html': '<p>hi</p>',
    'text/csv': 'a,b\n1,2',
    'application/json': '{"a":1}',
    'application/yaml': 'a: 1',
    'application/xml': '<a><b>1</b></a>',
  };
  const targets = [...Object.keys(samples), PDF, DOCX, 'image/png'];
  const declared = {
    'text/plain': [PDF, DOCX],
    'text/markdown': ['text/html', PDF, DOCX],
    'text/csv': ['application/json'],
    'application/json': ['application/yaml', 'application/xml'],
    'application/xml': ['application/json'],
  };

  for (const [from, body] of Object.entries(samples)) {
    for (const to of targets) {
      const expected = from === to || to === 'text/plain' || (declared[from] || []).includes(to);
      test(`${from} -> ${to}: ${expected ? 'converts' : 'is not supported'}`, async () => {
        const out = await convertFragment(buf(body), from, to);
        if (expected) expect(out).toBeDefined();
        else expect(out).toBeUndefined();
      });
    }
  }

  test('images convert between image types only', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    expect(await convertFragment(png, 'image/png', 'image/webp')).toBeDefined();
    expect(await convertFragment(png, 'image/png', PDF)).toBeUndefined();
    expect(await convertFragment(png, 'image/png', 'application/json')).toBeUndefined();
    expect(await convertFragment(png, 'image/png', 'text/html')).toBeUndefined();
  });

  test('the converters are strict about their input type, not just the target', async () => {
    expect(await convert(buf('<a/>'), 'application/xml', 'application/yaml')).toBeUndefined();
    expect(await convert(buf('{}'), 'application/json', PDF)).toBeUndefined();
    expect(await convert(buf('a,b'), 'text/csv', DOCX)).toBeUndefined();
    expect(await convert(buf('<p>x</p>'), 'text/html', PDF)).toBeUndefined();
    expect(await convert(buf('x'), 'text/plain', 'application/xml')).toBeUndefined();
    expect(await convert(buf('<a/>'), 'application/xml', 'application/xml')).toBeUndefined();
  });

  test('conversions only happen from the one right type: markdown becomes HTML, plain text does not', async () => {
    expect((await convertFragment(buf('# hi'), 'text/markdown', 'text/html')).trim()).toBe(
      '<h1>hi</h1>'
    );
    expect(await convertFragment(buf('# hi'), 'text/plain', 'text/html')).toBeUndefined();
    expect(await convertFragment(buf('a: 1'), 'application/yaml', 'text/html')).toBeUndefined();
  });

  test('JSON becomes YAML; CSV does not', async () => {
    expect(await convertFragment(buf('{"a":1}'), 'application/json', 'application/yaml')).toBe(
      'a: 1\n'
    );
    expect(await convertFragment(buf('a,b'), 'text/csv', 'application/yaml')).toBeUndefined();
  });

  test('CSV becomes JSON rows; XML becomes JSON; YAML does not', async () => {
    expect(
      JSON.parse(await convertFragment(buf('a,b\n1,2'), 'text/csv', 'application/json'))
    ).toEqual([{ a: '1', b: '2' }]);
    expect(
      await convertFragment(buf('a: 1'), 'application/yaml', 'application/json')
    ).toBeUndefined();
  });
});
