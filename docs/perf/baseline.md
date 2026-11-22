# Baseline load test (v0.9.0)

> **Status: NOT YET RUN.** The scripts and dashboard exist (`perf/`, `infra/modules/observability`),
> but nothing has been measured against AWS yet. Every number below is blank on purpose. Fill each
> one in only from a committed k6 summary or the CloudWatch dashboard, and say which.

## Setup (fill in when run)

| | |
|---|---|
| Date | |
| Git commit / image tag | |
| Region | us-east-2 |
| Service | 1 Fargate task, 0.25 vCPU / 512 MB (`infra/modules/ecs/main.tf`) |
| Client | k6 version, where it ran from (home network latency counts) |
| Auth | Cognito `USER_PASSWORD_AUTH` |
| Fixtures | text fragment, markdown fragment, `heavy.jpg` (1920x1080, 765 KiB) |

How to run each experiment: [`perf/README.md`](../../perf/README.md).

## Experiment 1: cheap reads, where does it break?

`READ_PCT=100 RATES=5,10,20,40,80`, summary: `docs/perf/exp1-reads.json` (not yet committed)

| Rate step (req/s) | read p50 | read p95 | read p99 | error rate |
|---|---|---|---|---|
| | | | | |

- Rate where error rate first exceeds 1%: **not measured**
- What saturated first (CPU or memory, from the dashboard): **not measured**

## Experiment 2: cheap-read p95 with and without heavy conversions

The number Phase 2 (async pipeline) has to improve.

| Run | read req/s | read p95 | read error rate | image (jpeg to avif) p95 |
|---|---|---|---|---|
| reads only | | | | n/a |
| 80% reads / 15% pdf+docx / 5% avif | | | | |

## Experiment 3: memory with a small file of huge pixel dimensions

Hypothesis: a PNG of a few hundred KB but ~256 megapixels can exhaust the 512 MB task when `sharp` decodes it.

| Input | Request | HTTP result | ECS memory peak | Task restarted? |
|---|---|---|---|---|
| 16000x16000 PNG, ~1 MB | `GET /v1/fragments/:id.avif` | | | |

- Outcome: **not measured**
- If it breaks the task, the fix is: lower the `sharp` pixel cap (`limitInputPixels`), return 413/422 instead of 500, and add a unit test and a Hurl case. Then re-run and record before/after here.

## Alarm drill

One alarm deliberately triggered and confirmed (needed for the Phase 1 Definition of Done):

| Alarm | How triggered | Notification received? |
|---|---|---|
| | | |
