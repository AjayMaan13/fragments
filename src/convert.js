// src/convert.js

// All fragment conversions live here, behind one entry point: convertFragment().
// The request handler (and, later, a queue worker) calls that and nothing else.
// The heavier output libraries (pdfkit, docx, fast-xml-parser) are loaded on
// first use, not at startup.

const MarkdownIt = require('markdown-it');
const yaml = require('js-yaml');
const csvtojson = require('csvtojson');
const sharp = require('sharp');

const md = new MarkdownIt();

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Widest an image may be resized to (pixels)
const MAX_WIDTH = 4096;

// Map a URL extension to the Content-Type it represents
const extToType = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.xml': 'application/xml',
  '.pdf': PDF,
  '.docx': DOCX,
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
};

const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif'];

// Map an image Content-Type to the format name sharp expects
const sharpFormatByType = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
};

// Protection for the small (0.25 vCPU / 512 MB) production task. Load tests
// showed two ways to kill it (docs/perf/baseline.md): one image with a huge
// pixel count, and many image conversions running at once. Both are limited here.
//
// A decoded image costs memory per *pixel*, not per byte, and a few hundred KB
// of PNG can hold hundreds of megapixels. 16 MP covers ordinary photos
// (a 12 MP phone camera) well inside the task's memory; tune with the env vars.
const maxImagePixels = () => Number(process.env.MAX_IMAGE_PIXELS) || 16_000_000;
// Image conversions allowed to run at once; beyond this we answer 503 instead of queueing
const maxConcurrentImages = () => Number(process.env.MAX_CONCURRENT_IMAGE_CONVERSIONS) || 2;
let imageConversionsInFlight = 0;

// A conversion we refuse on purpose (not a crash). `status` is the HTTP status
// the route should answer with; `retryAfter` (seconds) is set when retrying later can work.
class ConversionLimitError extends Error {
  constructor(message, status, retryAfter) {
    super(message);
    this.name = 'ConversionLimitError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// Convert image bytes to the target type, optionally shrinking to `width`
// pixels wide (aspect ratio kept; never enlarged).
const transformImage = async (data, targetType, width) => {
  if (imageConversionsInFlight >= maxConcurrentImages()) {
    throw new ConversionLimitError('Busy converting other images, try again shortly', 503, 5);
  }
  imageConversionsInFlight++;
  try {
    // Reading the size only parses the header; it does not decode the pixels.
    // (An animated image reports its frames stacked: use the height of one frame.)
    const meta = await sharp(data, { limitInputPixels: false }).metadata();
    const pixels = (meta.width || 0) * (meta.pageHeight || meta.height || 0);
    const limit = maxImagePixels();
    if (pixels > limit) {
      throw new ConversionLimitError(
        `Image is too large to convert (${meta.width}x${meta.pageHeight || meta.height}); the limit is ${limit / 1e6} megapixels`,
        422
      );
    }

    // limitInputPixels again as a second line of defence inside sharp itself
    const pipeline = sharp(data, { limitInputPixels: limit });
    if (width) pipeline.resize({ width, withoutEnlargement: true });
    return await pipeline.toFormat(sharpFormatByType[targetType]).toBuffer();
  } finally {
    imageConversionsInFlight--;
  }
};

// Flatten text into simple blocks - { text, level?, list?, code? } - that both
// document renderers draw the same way.
const toBlocks = (data, type) => {
  const text = data.toString();
  if (type !== 'text/markdown') return text.split(/\r?\n/).map((line) => ({ text: line }));

  const blocks = [];
  let level = 0;
  let list = 0;
  for (const token of md.parse(text, {})) {
    if (token.type === 'heading_open') level = Number(token.tag.slice(1));
    else if (token.type === 'heading_close') level = 0;
    else if (token.type === 'list_item_open') list++;
    else if (token.type === 'list_item_close') list--;
    else if (token.type === 'fence' || token.type === 'code_block') {
      token.content
        .trimEnd()
        .split('\n')
        .forEach((line) => blocks.push({ text: line, code: true }));
    } else if (token.type === 'inline') {
      const line = token.children.map((c) => (c.type === 'softbreak' ? ' ' : c.content)).join('');
      blocks.push({ text: line, level, list: list > 0 });
    }
  }
  return blocks;
};

const toPdf = (blocks) =>
  new Promise((resolve) => {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    for (const block of blocks) {
      const font = block.level ? 'Helvetica-Bold' : block.code ? 'Courier' : 'Helvetica';
      const size = block.level ? Math.max(12, 26 - 3 * block.level) : block.code ? 10 : 12;
      if (block.level) doc.moveDown(0.5);
      doc
        .font(font)
        .fontSize(size)
        .text(block.list ? `• ${block.text}` : block.text || ' ');
      if (!block.code) doc.moveDown(0.5);
    }
    doc.end();
  });

const toDocx = (blocks) => {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
  const paragraphs = blocks.map(
    (block) =>
      new Paragraph({
        heading: block.level ? HeadingLevel[`HEADING_${block.level}`] : undefined,
        bullet: block.list ? { level: 0 } : undefined,
        children: [new TextRun({ text: block.text, font: block.code ? 'Courier New' : undefined })],
      })
  );
  return Packer.toBuffer(new Document({ sections: [{ children: paragraphs }] }));
};

// `true` makes the parser throw on malformed XML instead of guessing
const xmlToJson = (data) => {
  const { XMLParser } = require('fast-xml-parser');
  return JSON.stringify(new XMLParser({ ignoreAttributes: false }).parse(data.toString(), true));
};

const jsonToXml = (data) => {
  const { XMLBuilder } = require('fast-xml-parser');
  const value = JSON.parse(data.toString());
  // XML documents have exactly one root element
  const hasRoot =
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1;
  return new XMLBuilder({ ignoreAttributes: false, format: true }).build(
    hasRoot ? value : { root: value }
  );
};

const renderers = { [PDF]: toPdf, [DOCX]: toDocx };

// Convert `data` of type `from` into type `to`. Resolves to the converted
// Buffer/string, or undefined when this module has no such conversion.
async function convert(data, from, to) {
  if (renderers[to] && (from === 'text/plain' || from === 'text/markdown')) {
    return renderers[to](toBlocks(data, from));
  }
  if (from === 'application/xml' && to === 'application/json') return xmlToJson(data);
  if (from === 'application/json' && to === 'application/xml') return jsonToXml(data);
}

// The single conversion entry point. Converts `data` of type `from` (a bare
// MIME type, no charset) into type `to`; images can also be shrunk to
// `options.width` pixels. Resolves to the converted Buffer/string, or
// undefined when there is no such conversion. Throws if the data can't be
// parsed or encoded (bad JSON, corrupt image...).
async function convertFragment(data, from, to, { width } = {}) {
  // Same type: nothing to convert, except an image may still be resized
  if (to === from)
    return width && imageTypes.includes(from) ? transformImage(data, to, width) : data;

  if (from === 'text/markdown' && to === 'text/html') return md.render(data.toString());

  if (from === 'application/json' && to === 'application/yaml') {
    return yaml.dump(JSON.parse(data.toString()));
  }

  if (from === 'text/csv' && to === 'application/json') {
    return JSON.stringify(await csvtojson().fromString(data.toString()));
  }

  // image -> image (any supported pair)
  if (imageTypes.includes(from) && imageTypes.includes(to)) return transformImage(data, to, width);

  // xml <-> json, markdown/text -> pdf/docx
  const converted = await convert(data, from, to);
  if (converted !== undefined) return converted;

  // Fallback: any supported text-ish type -> text/plain is just the raw bytes as text
  if (to === 'text/plain') return data;
}

module.exports = {
  convertFragment,
  convert,
  toBlocks, // exported so the markdown parsing can be tested directly
  ConversionLimitError,
  MAX_WIDTH,
  extToType,
  imageTypes,
  PDF,
  DOCX,
};
