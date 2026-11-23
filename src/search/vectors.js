// src/search/vectors.js

// Embedding vectors: stored as raw Float32 bytes, compared by dot product.
// Titan is asked for normalised vectors (length 1), so dot product IS cosine similarity.

const toBuffer = (vector) => {
  const floats = Float32Array.from(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
};

// DynamoDB hands binary back as a Uint8Array that may not be 4-byte aligned: copy it
const fromBuffer = (bytes) => {
  const copy = new Uint8Array(bytes).buffer;
  return new Float32Array(copy);
};

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function normalize(vector) {
  let norm = 0;
  for (const x of vector) norm += x * x;
  norm = Math.sqrt(norm);
  return norm === 0 ? Float32Array.from(vector) : Float32Array.from(vector, (x) => x / norm);
}

// Best `k` by score, highest first; ties keep a stable order by id
const topK = (items, k) =>
  [...items]
    .sort((x, y) => y.score - x.score || String(x.id).localeCompare(String(y.id)))
    .slice(0, k);

module.exports = { toBuffer, fromBuffer, dot, normalize, topK };
