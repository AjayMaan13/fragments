// src/search/index.js

// Semantic search over a user's text fragments. Indexing (worker): split a
// fragment into chunks, embed each, store them. Searching (API): embed the
// query, score the owner's chunks by dot product, best chunk per fragment.
//
// Brute force on purpose: fine up to a few thousand chunks per user. Beyond
// that you would move to a vector index (OpenSearch Serverless, pgvector),
// which costs money while idle; this project is applied and destroyed on demand.

const { Fragment } = require('../model/fragment');
const { listChunks, replaceChunks, deleteChunks } = require('../model/data');
const queue = require('../queue');
const logger = require('../logger');
const { isIndexable, textOf, chunk } = require('./chunker');
const { embed } = require('./embedder');
const { toBuffer, fromBuffer, dot, topK } = require('./vectors');

// Search is on when there is somewhere to keep the index (or SEARCH_ENABLED=1 for the in-memory store)
const isEnabled = () =>
  Boolean(process.env.AWS_DYNAMODB_EMBEDDINGS_TABLE_NAME) || process.env.SEARCH_ENABLED === '1';

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Ask the worker to (re)index a fragment. Best effort: a failure here must
 * never fail the request that created or changed the fragment.
 */
async function enqueueIndex(fragment, requestId) {
  if (!isEnabled() || !queue.isEnabled() || !isIndexable(fragment.mimeType)) return;
  try {
    await queue.sendEmbed({
      ownerId: fragment.ownerId,
      fragmentId: fragment.id,
      updated: fragment.updated,
      requestId,
    });
  } catch (err) {
    logger.warn({ err, id: fragment.id }, 'Could not queue fragment for indexing');
  }
}

// Drop a fragment from the index (best effort, like enqueueIndex)
async function removeFromIndex(ownerId, fragmentId) {
  if (!isEnabled()) return;
  try {
    await deleteChunks(ownerId, fragmentId);
  } catch (err) {
    logger.warn({ err, id: fragmentId }, 'Could not remove fragment from the search index');
  }
}

/**
 * Index one fragment (runs in the worker). Resolves to:
 *   'indexed'  chunks written
 *   'stale'    the fragment changed since the message was queued; a newer message covers it
 *   'skipped'  not a text type
 *   'gone'     deleted or expired; its chunks are removed
 */
async function indexFragment(ownerId, fragmentId, expectedUpdated) {
  let fragment;
  try {
    fragment = await Fragment.byId(ownerId, fragmentId);
  } catch (err) {
    if (!/^fragment not found/.test(err.message)) throw err;
    await deleteChunks(ownerId, fragmentId);
    return 'gone';
  }
  if (!isIndexable(fragment.mimeType)) return 'skipped';
  if (expectedUpdated && fragment.updated !== expectedUpdated) return 'stale';

  const pieces = chunk(textOf(await fragment.getData(), fragment.mimeType));
  const chunks = [];
  for (const [index, text] of pieces.entries()) {
    chunks.push({ index, text, vector: toBuffer(await embed(text)) });
  }
  await replaceChunks(ownerId, fragmentId, chunks, {
    updated: fragment.updated,
    expiresAt: fragment.expiresAt,
  });
  return 'indexed';
}

/**
 * The owner's best matches for a query: [{ id, score, snippet, type, size, created, updated }].
 * Only ever reads the owner's own chunks.
 */
async function search(ownerId, query, k = 5) {
  const queryVector = await embed(query);
  const now = nowSeconds();

  // best chunk per fragment
  const best = new Map();
  for (const item of await listChunks(ownerId)) {
    if (item.expiresAt !== undefined && item.expiresAt <= now) continue;
    const score = dot(queryVector, fromBuffer(item.vector));
    const current = best.get(item.fragmentId);
    if (!current || score > current.score) {
      best.set(item.fragmentId, { id: item.fragmentId, score, snippet: item.text });
    }
  }

  const results = [];
  // a few extra candidates: some may have been deleted or expired since they were indexed
  for (const hit of topK([...best.values()], k + 5)) {
    if (results.length === k) break;
    let fragment;
    try {
      fragment = await Fragment.byId(ownerId, hit.id);
    } catch {
      continue;
    }
    results.push({
      id: hit.id,
      score: Math.round(hit.score * 10000) / 10000,
      snippet: hit.snippet,
      type: fragment.type,
      size: fragment.size,
      created: fragment.created,
      updated: fragment.updated,
    });
  }
  return results;
}

module.exports = { isEnabled, enqueueIndex, removeFromIndex, indexFragment, search };
