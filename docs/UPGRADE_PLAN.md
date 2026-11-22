# Fragments upgrade plan: all 5 upgrades, 4 blocks

Written 2026-11-21 from the actual code (repo `AjayMaan13/fragments` + `fragments-ui`, local clone, baseline `v0.8.0`).
Estimates are mine: roughly 55-65 hours total, about 15 hours a week for 4 weeks. If finals squeeze a week, use the cut line at the bottom.

## The 5 upgrades (numbering from our earlier chat)

1. Async conversion pipeline (SQS + worker + DLQ)
2. Load testing with k6 (real numbers)
3. Test depth: mutation testing (Stryker) + UI end-to-end tests (Playwright)
4. AI search: embeddings + semantic search over fragments
5. Observability: dashboard, alarms, SLOs

## Order and why

| Block | Dates (target) | Phase | Upgrades | Tag when done |
|---|---|---|---|---|
| 1 | Nov 22 - 29 | Phase 0 cleanup + Phase 1 measure first | 5 + 2 | v0.9.0 |
| 2 | Nov 29 - Dec 6 | Phase 2 async pipeline | 1 | v0.10.0 |
| 3 | Dec 6 - 13 | Phase 3 test depth | 3 | v0.11.0 |
| 4 | Dec 13 - 20 | Phase 4 AI search + README/demo polish | 4 | v1.0.0 |

- Measure first (Block 1) so the async pipeline has a real before/after number instead of a claim.
- Test depth (Block 3) comes before AI (Block 4) because your stated priority is SDET/QA first, AI/ML third. AI is also the part that depends least on everything else, so it is the safest to shrink or cut.
- Every block ends in a mergeable, tagged state. Update the resume only with what has shipped and been measured.

## Ground rules

- A number goes on the resume only if you can name the command or dashboard that produced it. Add it to the verified ledger in `Fragments.md` the same day.
- One branch per phase, merged to `main` only when the phase's Definition of Done is met.
- Do not add: Kubernetes, a second database engine, a microservice split, a custom domain/TLS. (HTTP-only is already listed as a README limitation; leave it.)
- Before any load test: create an AWS Budget alert (about $10) so a mistake can't run up a bill.

---

## What I found in the code (the plan is built on this)

| Finding | Where | Why it matters |
|---|---|---|
| Fargate task is 0.25 vCPU / 512 MB, one task | `infra/modules/ecs/main.tf` | Real throughput will be tens to low hundreds of requests/sec, not thousands. Report what you measure. |
| All conversions run inside the request handler | `src/routes/api/getId.js` (md->html, json->yaml, csv->json, image) and `src/convert.js` (xml, pdf, docx) | Dispatch logic is split across two files. It must be extracted into one function before a worker or mutation testing can use it. |
| Body limit 5 MB, images decoded with `sharp` in-process | `src/routes/api/index.js`, `getId.js` | Hypothesis to test in Phase 1: a small file with huge pixel dimensions could use more memory than a 512 MB task has. Untested; measure before claiming anything. |
| `listFragments` queries every item for an owner and builds `new Fragment()` from each | `src/model/data/aws/index.js`, `src/model/fragment.js` | Job records or embeddings must NOT go in the fragments table: the constructor throws on items without a valid `type`, and `expand` would return big vectors. Use separate tables. |
| CI runs `npm install-ci-test` (no coverage flag) | `.github/workflows/ci.yml` | The 80% `coverageThreshold` in `jest.config.js` only applies when coverage is collected, so CI never enforces it. Your 94.57% comes from running `npm run coverage` by hand. |
| Raw bearer token is logged on verification failure | `src/auth/cognito.js` (`logger.error({ err, token }, ...)`) | Fix before building log-based dashboards. Tokens should not sit in CloudWatch. |
| Cognito app client allows only SRP + refresh flows | `infra/modules/auth/main.tf` | k6 can't log in as-is. Needs a Terraform-gated `ALLOW_USER_PASSWORD_AUTH` (default off). |
| CD updates only `fragments-service`; deploy role can only update that ARN and pass those two task roles | `.github/workflows/cd.yml`, `infra/modules/cicd/main.tf` | A worker service needs both changed or it never gets new images. |
| MiniStack runs `SERVICES=s3` only | `docker-compose.yml`, `scripts/local-aws-setup.sh` | Its docs list SQS, Lambda, CloudWatch and Bedrock Runtime (deterministic mocks) as supported, so add SQS locally. Mocked Bedrock can't judge search relevance. |
| `fragments-ui` has no tests and no CI in the local clone | `fragments-ui/` | Playwright work includes adding a workflow. |
| Dockerfile copies `tests/.htpasswd` into the production image | `Dockerfile` | Harmless because production disables Basic auth, but unnecessary. Optional: bind-mount it in compose instead. |
| `docs/EXPANSION_PLAN.md` describes a different design (bootstrap/, dns-tls, QR codes, 11 types, CloudFront) | `docs/` | Stale and public. Delete it or move it to `docs/history/` so the README is the only spec. |

---

## Phase 0: cleanup (about 3 hours, before anything else)

1. Run `npm run coverage`; record the real number. Change the `unit-tests` job in `ci.yml` to run `npm run coverage` so the 80% gate is enforced. Align README ("~95%") with the measured 94.57%.
2. Refactor: move the conversion dispatch out of `getId.js` into one function in `src/convert.js`, e.g. `convertFragment(data, fromType, toType, { width })`. `getId.js` becomes a thin caller. The existing `convert.test.js` and `getId-conversion.test.js` are the safety net; all 195 tests and the Hurl suite must stay green.
3. Remove `token` from the log call in `src/auth/cognito.js`.
4. Delete or archive `docs/EXPANSION_PLAN.md`.
5. Optional: stop baking `.htpasswd` into the image (compose bind-mount).
6. Rewrite the Fragments resume bullets from the verified ledger only (separate task; see the bullet shapes at the end).

---

## Phase 1: observability + baseline load test (Block 1, upgrades 5 and 2)

Goal: know what the system does before changing it.

### 1a. Observability (new Terraform module #10: `infra/modules/observability`)
- Inputs: ALB and target-group `arn_suffix` (add as outputs in the `alb` module), ECS cluster/service names, log group name.
- One CloudWatch dashboard: request count, 5xx count, `TargetResponseTime` p50/p95/p99, healthy host count, ECS CPU and memory utilization.
- Alarms (SNS email topic): target 5xx rate, p95 latency, unhealthy hosts, ECS memory above 80%.
- Custom metrics with no new infrastructure: a small `src/metrics.js` that writes CloudWatch Embedded Metric Format lines through pino (per-conversion duration, dimension = target type only, to keep the metric count low).
- Request correlation: honor an incoming request ID header in `pino-http` (`genReqId`), return it as `X-Request-Id`. Phase 2 will carry it in queue messages.
- SLOs: define them for the hours the stack is up (e.g. non-5xx ratio, p95 for cheap reads). Set the targets after you have the baseline. Because you tear the stack down between sessions, never claim "uptime %"; claim error rate and latency under a stated load.

### 1b. k6 (new `perf/` folder)
- `smoke.js`: health, create, get, delete.
- `mixed.js`: ramping arrival rate. About 80% cheap reads, 15% small conversions (md -> pdf/docx), 5% heavy image conversion. Tag requests by type and set thresholds on the cheap-read p95 and `http_req_failed`.
- CI job `perf-smoke`: runs `smoke.js` against the compose stack (Basic auth), uploads the k6 summary as an artifact. Generous thresholds only; CI runner variance makes tight latency gates flaky.
- Live runs: manual (local or `workflow_dispatch`) against the ALB after `terraform apply`. For login, add a Terraform variable (default off) that adds `ALLOW_USER_PASSWORD_AUTH` to the Cognito client, create a test user with `aws cognito-idp admin-create-user` + `admin-set-user-password`, and let k6 call `InitiateAuth` to get the ID token. Turn the flag back off afterwards.

### 1c. Experiments (commit raw k6 summaries + a short `docs/perf/baseline.md`)
1. Cheap-read p50/p95/p99 and the request rate where error rate first exceeds 1%.
2. Cheap-read p95 with and without the heavy image conversions running: this is the number Phase 2 must improve.
3. Memory hypothesis: upload a small-bytes, huge-dimension PNG and watch ECS memory and task restarts. If it breaks the task, fix it (lower `sharp` pixel cap, return 413/422, add a unit test and a Hurl case). That is a "found by load testing, fixed, tested" story.

### Definition of done
Dashboard visible after `terraform apply`; one alarm deliberately triggered and confirmed; `baseline.md` has experiments 1-3 with real numbers; ledger updated; tag `v0.9.0`.

---

## Phase 2: async pipeline (Block 2, upgrade 1)

Existing sync routes stay unchanged (backward compatible, Hurl tests stay green). Add:

### API
- `POST /v1/fragments/:id/jobs` with `{ "to": ".avif", "width": 800 }`. Validate against the existing extension map and `fragment.formats`. Create a job record, send an SQS message, return `202` with `Location: /v1/jobs/:jobId`.
- `GET /v1/jobs/:jobId` returns status (`queued | running | succeeded | failed`), attempts, and a pre-signed result URL (max 1 hour) when done. Strictly scoped to the owner.
- Memory mode returns `501`, same pattern as share links today.

### Data and infrastructure
- New DynamoDB table `fragments-jobs` (PK `ownerId`, SK `jobId`, TTL). Not the fragments table (see findings).
- Results go to S3 under `results/<ownerId>/<jobId>` (not the `ownerId/id` shape the expiry Lambda deletes), plus a lifecycle rule expiring `results/` after a day.
- New module `queue`: main SQS queue + dead-letter queue (`maxReceiveCount = 3`), visibility timeout longer than the worst-case job, long polling.
- Worker: same Docker image, entry `node src/worker.js`, as a second ECS service `fragments-worker` (no load balancer), `worker_desired_count` default 0 like the API.
- IAM: API task role gets `sqs:SendMessage` + jobs table; a separate worker role gets receive/delete/change-visibility + S3 + jobs table.
- CD: extend `cd.yml` with a second render/deploy step for the worker container, and extend the `cicd` module (`ecs:UpdateService` resource list and `iam:PassRole` roles) for the worker service and role. Easy to forget; without it the worker never gets new images.
- Local: `SERVICES=s3,sqs` in `docker-compose.yml`, a `fragments-worker` compose service, and queue/table creation in `scripts/local-aws-setup.sh`.

### Worker behavior
- Long-poll; conditional update `queued -> running` (idempotency: a redelivered message must not produce a second result); call the extracted `convertFragment`; write result; mark `succeeded`; delete the message.
- On failure leave the message for retry; on the last attempt (`ApproximateReceiveCount` equals the max) mark `failed` with the error. The DLQ catches anything else.

### Alternative I rejected
Lambda with an SQS event-source mapping: needs `sharp`/`pdfkit` packaging and a separate deploy path, and you already have one Lambda (expiry cleanup). Same image on Fargate reuses your Dockerfile, ECR and CD.

### Tests
Unit: job state machine; same message twice gives one result; poison message ends in `failed`. Hurl: POST job returns 202, poll to `succeeded`, fetch result; another user's job returns 404 (authorization test).

### Observability tie-in
Alarms on DLQ depth above 0 and oldest-message age; queue depth on the dashboard; job duration metric; request ID carried in message attributes.

### Measure
Re-run Phase 1 experiment 2 with heavy conversions routed through jobs: cheap-read p95 before vs after; job end-to-end latency p50/p95; kill the worker mid-job and confirm the job completes exactly once after the visibility timeout.

### Stretch (only if time)
ECS service auto scaling on queue backlog per task.

### Definition of done
Before/after numbers committed; failure and redelivery behavior demonstrated; CD updates both services; tag `v0.10.0`.

---

## Phase 3: test depth (Block 3, upgrade 3)

### Mutation testing
- `@stryker-mutator/core` + `@stryker-mutator/jest-runner`, `stryker.conf.json` reusing `jest.config.js`. Mutate `src/convert.js`, `src/model/fragment.js`, `src/routes/api/*.js`, and the new job code. Use `coverageAnalysis: perTest` and incremental mode.
- CI: a separate scheduled + `workflow_dispatch` workflow that uploads the HTML report; not on every PR (slow). Set the `break` threshold only after you see the baseline score.
- Use the survivors: the logic-dense spots are the `expiresIn` and `width` bounds checks (`post.js`, `getId.js`), `share.js` limits, and `createShareLink`'s `Math.max/Math.min` clamp. Write tests to kill meaningful survivors.
- Honest metric to report: baseline mutation score vs coverage, then the score after your added tests (count the tests, per file).

### Playwright (in `fragments-ui`)
- Tier 1 (CI, no AWS): build the UI with dummy Cognito env values, seed an OIDC session in browser storage (confirm the exact `oidc-client-ts` storage key when you implement), and mock `**/v1/**` with `page.route`. Cover list, create, convert/download, share link, delete, and error states. Add a `fragments-ui` CI workflow.
- Tier 2 (manual only): one spec that drives the real Cognito hosted login with the Phase 1 test user against a deployed stack: create, convert, share, delete. Run through `workflow_dispatch` with the test credentials in GitHub secrets.
- Skip API-level Playwright tests; Hurl already covers the API.

### Definition of done
Mutation report committed with before/after score; Playwright Tier 1 green in CI; tag `v0.11.0`.

---

## Phase 4: AI search (Block 4, upgrade 4)

Scope: semantic search over a user's text fragments (`text/plain`, `text/markdown`, HTML with tags stripped). No OCR.

- Embeddings: Bedrock Titan Text Embeddings V2 (`amazon.titan-embed-text-v2:0`). AWS's regional availability page lists it as in-region in us-east-2. Confirm model access is enabled in your account and check current pricing. IAM-only (no API keys), so the "no stored credentials" story holds. Vector size 256 or 512 with normalization, so cosine similarity is a dot product.
- Indexing reuses the Phase 2 queue: after create/update of an indexable type the API enqueues an `embed` job. Worker chunks the text (about 800-1,000 characters with small overlap, capped per fragment), embeds each chunk, stores it. Skip stale jobs (compare fragment `updated`).
- Storage: new table `fragments-embeddings` (PK `ownerId`, SK `<id>#<chunk>`), vector stored as binary Float32, `expiresAt` copied from the fragment. `Fragment.delete` and `PUT` must remove or replace the old chunks.
- Search: `GET /v1/search?q=...&k=5` embeds the query (API role also needs `bedrock:InvokeModel` for this one model), loads the owner's chunks, brute-force cosine in memory, joins fragment metadata, drops expired. Fine up to a few thousand chunks per user. Write down in the README where you would switch to a real vector index and why (always-on cost conflicts with your apply/destroy habit).
- Evaluation (this is what makes it credible): `eval/` with 25-40 documents and 20-30 labeled queries. Report recall@1/3/5 and MRR, plus a keyword-overlap baseline. Run against real Bedrock (a script, not CI). Report the numbers even if they're modest. Local MiniStack Bedrock mocks are deterministic, so they can't measure relevance.
- Tests: unit tests with an injected fake embedder: chunker boundaries, top-k ordering, user A can never retrieve user B's chunks, re-embed on PUT, delete cascade, expiry. Hurl: 501 in memory mode.
- Also: add the new module to the Stryker `mutate` list.
- Stretch (skip first): search box in `fragments-ui`; `/v1/ask` with a Bedrock chat model.

### Definition of done
Eval numbers committed; ownership-isolation test green; README + short demo clip updated; tag `v1.0.0`.

---

## Cost and teardown

- Keep the apply/destroy habit. A second Fargate task (worker) roughly doubles compute while up; destroy it with the rest. SQS and Lambda sit in the free tier at this scale. Bedrock embeddings and CloudWatch alarms/metrics should be small, but check current AWS pricing and your Cost Explorer after Block 1 and Block 4.
- Confirm `terraform destroy` still works cleanly after each phase (new tables, queue, and the metrics module must all tear down).

## Cut line (if time runs out)

Never cut: Phase 0, Phase 1 measurements, Phase 2 core (queue, worker, jobs API, DLQ).
Cut first, in this order: Phase 3 Tier 2 live E2E, UI search box, Phase 3 Tier 1 Playwright, Phase 4 chunking (embed a truncated document instead), Phase 2 auto scaling. If you must drop a whole phase, drop Phase 4 and keep mutation testing.

## Ledger additions (metric -> how to measure)

| Metric | Command / source |
|---|---|
| Real coverage | `npm run coverage` |
| Cheap-read p95, max sustainable rate | k6 summary JSON in `docs/perf/` |
| Cheap-read p95 with heavy conversions, before vs after async | same k6 scenario, v0.9.0 vs v0.10.0 |
| Job latency p50/p95, exactly-once after worker kill | k6 + CloudWatch + worker logs |
| Mutation score before/after, tests added | Stryker report |
| recall@k, MRR vs keyword baseline | `eval/` script output |
| Terraform modules/resources | `terraform state list \| wc -l` and module count |

## Bullet shapes (fill ONLY from the ledger once measured)

- Load-tested a [N]-vCPU Fargate service with k6 ([scenario]); found [specific finding], fixed it, and cut cheap-read p95 from [A] ms to [B] ms by moving heavy conversions to an SQS + worker pipeline with a DLQ.
- Raised mutation score on [modules] from [A]% to [B]% (Stryker) by adding [N] targeted tests; gated in CI on a schedule.
- Built [N]-widget CloudWatch dashboard, [N] alarms and SLO-based alerts in Terraform; request IDs propagated through queue messages.
- Added semantic search (Titan embeddings, [dims]-dim, cosine) with a [N]-query eval set: recall@3 [X]% vs [Y]% for a keyword baseline.

## Decisions I made for you (change any you disagree with)

Worker as a second ECS service from the same image (not Lambda); separate DynamoDB tables for jobs and embeddings; Titan V2 via Bedrock (not an external API key); brute-force cosine search (no vector database); mutation testing before AI; k6 login via a Terraform-gated password flow.
