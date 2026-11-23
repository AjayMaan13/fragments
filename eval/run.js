// eval/run.js

// How good is the search? Embeds every document in eval/corpus.json, ranks them
// for each query in eval/queries.json (labelled with the document that answers
// it), and reports recall@1/3/5 and mean reciprocal rank (MRR), next to a plain
// keyword-overlap baseline.
//
//   node eval/run.js --embedder bedrock    real Titan V2 (needs AWS credentials + model access)
//   node eval/run.js --embedder fake       the deterministic word-hashing embedder (a sanity check)
//
// Results are written to eval/results/<embedder>.json. This runs the same
// chunking, embedding and dot-product code as the service, minus the database.

const fs = require('fs');
const path = require('path');

const embedderName = process.argv.includes('--embedder')
  ? process.argv[process.argv.indexOf('--embedder') + 1]
  : 'bedrock';
process.env.EMBEDDER = embedderName === 'fake' ? 'fake' : '';
if (embedderName === 'bedrock') process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-2';

const { chunk } = require('../src/search/chunker');
const { embed, dimensions, MODEL_ID } = require('../src/search/embedder');
const { dot } = require('../src/search/vectors');

const corpus = require('./corpus.json');
const queries = require('./queries.json');
const KS = [1, 3, 5];

const STOP = new Set(
  'a an and are as at be by do for from how i in is it my of on or so that the to what why with you your can not when each than only'.split(
    ' '
  )
);
const words = (text) => (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w));

// Baseline: how many distinct query words appear in the document
const keywordScore = (query, text) => {
  const doc = new Set(words(text));
  return new Set(words(query)).size
    ? [...new Set(words(query))].filter((w) => doc.has(w)).length
    : 0;
};

function metrics(rankings) {
  const out = { mrr: 0 };
  for (const k of KS) out[`recall@${k}`] = 0;
  rankings.forEach(({ ranked, relevant }) => {
    const rank = ranked.findIndex((id) => relevant.includes(id)) + 1; // 0 if not found
    if (rank) out.mrr += 1 / rank;
    for (const k of KS) if (rank && rank <= k) out[`recall@${k}`] += 1;
  });
  for (const key of Object.keys(out))
    out[key] = Math.round((out[key] / rankings.length) * 1000) / 1000;
  return out;
}

async function main() {
  // best chunk per document, as the service does
  const docs = [];
  for (const d of corpus) {
    const vectors = [];
    for (const piece of chunk(d.text)) vectors.push(await embed(piece));
    docs.push({ id: d.id, text: d.text, vectors });
  }

  const semantic = [];
  const keyword = [];
  const misses = [];
  for (const { q, relevant } of queries) {
    const qv = await embed(q);
    const bySemantic = docs
      .map((d) => ({ id: d.id, score: Math.max(...d.vectors.map((v) => dot(qv, v))) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const byKeyword = docs
      .map((d) => ({ id: d.id, score: keywordScore(q, d.text) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    semantic.push({ ranked: bySemantic.map((r) => r.id), relevant });
    keyword.push({ ranked: byKeyword.map((r) => r.id), relevant });
    if (!relevant.includes(bySemantic[0].id))
      misses.push({ q, expected: relevant, got: bySemantic[0].id });
  }

  const result = {
    embedder: embedderName,
    model: embedderName === 'bedrock' ? MODEL_ID : 'fake word-hashing embedder',
    dimensions: dimensions(),
    documents: corpus.length,
    queries: queries.length,
    date: new Date().toISOString().slice(0, 10),
    semantic: metrics(semantic),
    keywordBaseline: metrics(keyword),
    semanticTop1Misses: misses,
  };
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, 'results', `${embedderName}.json`),
    JSON.stringify(result, null, 2) + '\n'
  );

  console.log(
    `${result.model} (${result.dimensions} dims), ${result.documents} documents, ${result.queries} queries`
  );
  console.log('                   recall@1  recall@3  recall@5     MRR');
  const row = (name, m) =>
    console.log(
      `${name.padEnd(18)} ${[m['recall@1'], m['recall@3'], m['recall@5'], m.mrr].map((x) => x.toFixed(3).padStart(8)).join('  ')}`
    );
  row('semantic', result.semantic);
  row('keyword baseline', result.keywordBaseline);
  for (const m of misses) console.log(`  top-1 miss: "${m.q}" expected ${m.expected} got ${m.got}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
