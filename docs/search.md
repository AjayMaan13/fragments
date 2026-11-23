# Semantic search

`GET /v1/search?q=...&k=5` returns a user's most relevant text fragments by meaning. How it works is in the [README](../README.md#semantic-search); this page is about how good it is.

## Evaluation

`node eval/run.js --embedder bedrock` (needs AWS credentials and Bedrock model access for `amazon.titan-embed-text-v2:0` in us-east-2). It embeds the 30 documents in [`eval/corpus.json`](../eval/corpus.json), ranks them for each of the 25 queries in [`eval/queries.json`](../eval/queries.json), and compares against a keyword-overlap baseline. It runs the same chunking, embedding and dot-product code as the service, without the database. Raw results: [`eval/results/bedrock.json`](../eval/results/bedrock.json).

Measured 2026-11-22, Titan Text Embeddings V2, 256 dimensions:

| | recall@1 | recall@3 | recall@5 | MRR |
|---|---|---|---|---|
| **Titan V2 (semantic)** | **1.000** | **1.000** | **1.000** | **1.000** |
| Keyword overlap (baseline) | 0.440 | 0.560 | 0.600 | 0.530 |
| Fake local embedder (sanity check only) | 0.200 | 0.320 | 0.400 | 0.317 |

recall@k is the share of queries whose correct document is in the top k; MRR is the mean of 1/rank of the correct document.

### How much to trust this

**This is an easy benchmark, and a perfect score on it does not mean the search is perfect.**

- **I wrote it.** The documents and the labelled queries were written by one author in one sitting. The queries are deliberate paraphrases ("preparing for a 26-mile race" for a marathon note), which is exactly what embeddings are good at and keyword search is bad at, so the gap to the baseline is probably larger than on real queries.
- **It is small and clean:** 30 short documents on 30 clearly different topics, one correct answer per query, no near-duplicates, no long documents, no typos, one language.
- **What it does show:** the pipeline works end to end with the real model, and meaning-based matching beats word overlap decisively on paraphrased queries (recall@1 1.00 against 0.44).
- **What it does not show:** accuracy on a user's real, messy notes, on long documents (chunking is tested but not evaluated here), or on queries whose answer is several documents. A harder, larger set (real notes, hard distractors, queries with several answers) is the obvious next step.
- **The fake embedder** (used for local runs and tests) hashes words, so it only matches shared words and scores below the keyword baseline. It exists so the plumbing runs without AWS.

## Cost and limits

- Titan V2 charges per input token (check current Bedrock pricing); one chunk is about 200 tokens, so indexing a 1,000-character note costs a fraction of a cent. Each search embeds one short query.
- Brute-force search loads the caller's chunks from DynamoDB on every query. Fine for a few thousand chunks; beyond that, use a vector index (always-on cost, which conflicts with applying and destroying the stack).
- A fragment is indexed by its first 40 chunks (about 36,000 characters).
- Only `text/plain`, `text/markdown` and `text/html` are indexed (HTML as the text a reader sees). Images and other types are not.

## Not verified on AWS

The API-to-Bedrock path inside ECS (the IAM policy scoped to the one model, the embeddings table, the worker indexing through real SQS) has been validated by `terraform validate` and, locally, against MiniStack and DynamoDB Local with the fake embedder, but **not deployed**: the stack was torn down at the end of Phase 3. The Bedrock calls themselves were run for real, from a laptop, by the evaluation.
