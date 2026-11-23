// src/search/chunker.js

// Turn a fragment's bytes into the text we embed, and split long text into
// overlapping chunks so each piece fits one embedding and a match points at the
// part of the document that matters.

const INDEXABLE = ['text/plain', 'text/markdown', 'text/html'];
const isIndexable = (mimeType) => INDEXABLE.includes(mimeType);

const entities = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

// HTML to the text a reader sees: drop scripts and styles, drop tags, decode the common entities
function stripHtml(html) {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => entities[m])
    .replace(/\s+/g, ' ')
    .trim();
}

// The searchable text of a fragment of a given type
function textOf(data, mimeType) {
  const text = data.toString('utf8');
  return (mimeType === 'text/html' ? stripHtml(text) : text).replace(/\s+/g, ' ').trim();
}

/**
 * Split text into chunks of about `size` characters that overlap by `overlap`,
 * cutting at a space where there is one. At most `max` chunks (a very long
 * document is searchable by its beginning rather than not at all).
 */
function chunk(text, { size = 900, overlap = 100, max = 40 } = {}) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const chunks = [];
  let start = 0;
  while (start < clean.length && chunks.length < max) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      // prefer to cut at the last space in the final 40% of the window
      const space = clean.lastIndexOf(' ', end);
      if (space > start + size * 0.6) end = space;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    // step back by the overlap, but always move forward
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

module.exports = { INDEXABLE, isIndexable, stripHtml, textOf, chunk };
