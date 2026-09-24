// src/convert.js

// Conversions that produce new formats: XML <-> JSON, and markdown/plain text
// -> PDF or DOCX. The libraries are loaded on first use, not at startup.

const MarkdownIt = require('markdown-it');

const md = new MarkdownIt();

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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

module.exports = { convert, PDF, DOCX };
