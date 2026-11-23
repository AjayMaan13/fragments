// src/search/embedder.js

// Text to a vector. In AWS this is Amazon Bedrock's Titan Text Embeddings V2:
// IAM-only (the task role), no API keys stored anywhere. Locally and in tests
// EMBEDDER=fake (or setEmbedder) uses a deterministic word-hashing embedder, so
// nothing needs AWS. The fake is lexical (shared words), not semantic: it proves
// the plumbing, not search quality. Quality is measured with the real model (eval/).

const { normalize } = require('./vectors');

const MODEL_ID = 'amazon.titan-embed-text-v2:0';
// Smaller vectors are cheaper to store and compare; 256 is one of Titan V2's sizes
const dimensions = () => Number(process.env.EMBEDDING_DIMENSIONS) || 256;

let override;
// Tests inject their own embedder: async (text) => Float32Array
const setEmbedder = (fn) => {
  override = fn;
};

// FNV-1a: a small, stable string hash
function hash(word) {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

async function fakeEmbed(text) {
  const dims = dimensions();
  const vector = new Float32Array(dims);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) || []) {
    const h = hash(word);
    vector[h % dims] += h & 0x80000000 ? -1 : 1;
  }
  return normalize(vector);
}

let client;
async function bedrockEmbed(text) {
  const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
  client = client || new BedrockRuntimeClient({ region: process.env.AWS_REGION });
  const response = await client.send(
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ inputText: text, dimensions: dimensions(), normalize: true }),
    })
  );
  const { embedding } = JSON.parse(Buffer.from(response.body).toString('utf8'));
  return Float32Array.from(embedding);
}

const embed = (text) => {
  if (override) return override(text);
  return process.env.EMBEDDER === 'fake' ? fakeEmbed(text) : bedrockEmbed(text);
};

module.exports = { embed, setEmbedder, fakeEmbed, MODEL_ID, dimensions };
