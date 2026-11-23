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

## Verified on the deployed stack

Run on 2026-11-22 against the real stack (`v1.0.0` image, API and worker on Fargate, Bedrock called through the task roles, real DynamoDB and SQS), then torn down:

- Three notes were created; the worker had embedded all three **within seconds** (3 of 3 at the first check, 3 `Indexed fragment for search` lines in the worker log), so the IAM policy for Bedrock and the embeddings table work.
- Paraphrased queries found the right note with no shared words: "how do I keep my bread culture alive" returned the sourdough note, "my pet stopped eating and is hiding" returned the cat-health note, "how to make database lookups faster" returned the database-index note. Each search took about 0.2 s measured from a laptop, including the Bedrock call for the query.
- A second user searching the same words got no results (isolation).
- After deleting the sourdough note it no longer appeared in results.

This was a functional check of three notes and a few queries, not a load or accuracy test; accuracy is the evaluation above.
