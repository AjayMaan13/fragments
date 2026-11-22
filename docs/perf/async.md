# Async conversion pipeline: before and after (v0.10.0-rc1)

Measured 2026-11-22 against the deployed stack, from a MacBook Air over home internet (client-side latencies include the network, about a 20-30 ms floor), same method as [`baseline.md`](baseline.md). Every number comes from a k6 summary in this folder, from CloudWatch, or from the jobs table's own timestamps, and says which.

| | |
|---|---|
| Image | `v0.10.0-rc1` |
| API | 1 task, 0.25 vCPU / 512 MB (unchanged) |
| Worker | 1 task, **0.5 vCPU / 1 GB**, one job at a time (`infra/modules/worker`) |
| Queue | SQS, visibility timeout 120 s, dead-letter queue after 3 deliveries |
| Jobs | `POST /v1/fragments/:id/jobs`, then the worker converts; same `convertFragment` as the sync path |

## 1. What one job costs on an idle worker

One avif job at a time, `heavy.jpg` (1920x1080 JPEG, 765 KiB), times from the job record's `createdAt` to `updatedAt`:

| Job | Time |
|---|---|
| jpeg to avif | **19.3 s, 19.5 s, 19.1 s** (the worker's own `processingMs`: 19.2 s and 19.5 s) |
| markdown to pdf | 0.4 s end to end (processing 56 ms, 60-70 ms for pdf/docx in later runs) |

The same conversion took about 33 s on the API's 0.25 vCPU task. One worker can therefore finish about **0.05 avif jobs per second** (one every 19 s).

## 2. Experiment 2 again: the mix that broke the API

Identical offered load to the Phase 1 re-run: 20 req/s for 3 minutes, 80% cheap reads / 15% pdf+docx / 5% avif, which is 16 reads, 3 small conversions and 1 avif per second. The only difference: conversions are sent as jobs (`ASYNC=1`) and not waited for.
Summary: [`exp2async-mixed-20rps.json`](exp2async-mixed-20rps.json). Before: [`exp2fix-mixed-20rps.json`](exp2fix-mixed-20rps.json) (sync, `v0.9.0-rc2`).

| | sync (rc2) | async (rc1 of v0.10.0) |
|---|---|---|
| cheap-read p50 | 6.1 s | **30 ms** |
| cheap-read p95 | 60.0 s (k6 timeout floor) | **67 ms** |
| cheap-read p99 | 60.0 s | 166 ms |
| failed requests | 1,153 / 2,924 (39%) | **0 / 3,712** |
| iterations k6 had to drop | 782 | 0 |
| API CPU, busiest minutes | 100% | 38-52% (CloudWatch) |
| API memory | up to 63% | 11% |
| API task restarted | yes (health checks) | **no** (same task id before and after) |
| submitting a conversion (POST) p95 | n/a | 76 ms (pdf/docx), 88 ms (avif) |

For reference, reads alone at 16 req/s gave 63-70 ms p95 in Phase 1. **With heavy conversions offered, reads now behave as if the conversions were not there.** The conversions went to the worker, which ran at 99-100% CPU for the whole run (worker memory peaked at 34%).

### What happened to those jobs (read from the jobs table)

740 jobs were created. Only 41 finished during the run (10 avif, 15 pdf, 16 docx). The other 699 were still queued when k6's teardown deleted the source fragments, so the worker failed them with "Fragment not found" almost instantly. **Those failures are an artifact of my test teardown, not worker failures**; the run offered 1 avif/s to a worker that does 0.05/s, so a backlog was certain. (`DRAIN_SECONDS` was added to `perf/mixed.js` afterwards.)

## 3. A load the worker can sustain

16 reads/s plus about 1 small job/s plus 1 avif per ~30 s (17 req/s for 5 minutes, `RATES=17 READ_PCT=94.12 CONVERT_PCT=5.69 IMAGE_PCT=0.19`, no polling, 90 s drain before cleanup). Summary: [`exp2async-sustainable-20rps.json`](exp2async-sustainable-20rps.json) (file name says 20; the rate was 17). Job latencies are exact server-side timestamps from the jobs table.

| | result |
|---|---|
| cheap reads p50 / p95 / p99 | **30 / 63 / 100 ms**, 0 failed of 5,194 |
| API CPU | 19-32% |
| jobs | **330 / 330 succeeded** (157 pdf, 161 docx, 12 avif), none failed, dead-letter queue empty |
| pdf/docx job end to end, p50 / p95 / max | 11.0 s / 80.6 s / 107.9 s (docx: 14.6 / 84.8 / 108.5 s), though processing takes 0.06-0.07 s |
| avif job end to end, p50 / p95 / max | 30.8 s / 54.1 s / 91.2 s (12 samples; processing 19.0 s) |
| worker CPU | 100% for most of the run |

**The API is fully protected, but job latency is poor even at this load.** The worker is the bottleneck: 12 avif jobs x 19 s is about 74% of the worker's time, plus the small jobs' overhead, so it sat at 100% CPU and a queue built up. Small jobs also wait behind avif jobs in the single FIFO queue (head-of-line blocking): a 0.07 s job can wait 19 s per avif ahead of it.

## 4. A measurement mistake worth recording

My first sustainable-load attempt polled every job once per second to time it. The result ([`exp2async-polling-confounded.json`](exp2async-polling-confounded.json)) looked bad: read p95 2.3 s and job p95 74 s, ALB traffic climbing to about 97 req/s and API CPU 99%. **That run is confounded and is not used for any claim above.** The cause was the polling itself: each waiting job generated a request per second, and the growing backlog fed more polls. It is still a real finding: clients that poll a job every second cost the API real capacity (the API saturates near 100 req/s, see `baseline.md`), so a client should back off, and the API could return a `Retry-After`.

## 5. Failure and redelivery

| Scenario | Where | Result |
|---|---|---|
| Worker **killed** (SIGKILL) mid-job | local, MiniStack, docker compose | Message reappeared exactly 120 s later (the visibility timeout); attempt 2 completed the job; **one** success event; dead-letter queue empty |
| Worker **stopped** (SIGTERM, as in a deploy) mid-job | **AWS** | Job finished on attempt 1, 19.5 s after the signal (worker log: "Stopping after the current job", then "Job succeeded", then "Worker stopped"); no duplicate; ECS started a replacement worker which never touched the job |
| Same message delivered twice, two workers at once, poison message, lost lease | unit tests (`tests/unit/worker.test.js`, `job-store.test.js`) | One result; the loser backs off; ends `failed` on attempt 3; a late worker cannot overwrite the new owner |

**Not tested on AWS:** a hard crash (a Fargate container cannot be SIGKILLed without ECS Exec, which is not enabled), and a message actually landing in the dead-letter queue (it needs three worker crashes in a row). Both rest on the unit tests and the local run.

## 6. What this means

- **Done:** heavy work no longer touches the API. The Phase 1 failure (reads at 60 s or worse, 39% errors, task killed) is gone with the same offered load.
- **New bottleneck:** one 0.5 vCPU worker finishes about one avif per 19 s. Anything more than that backs up linearly.
- **Next options (not built):** more workers or auto scaling on queue depth (the plan's stretch); a separate queue or worker pool for heavy conversions so small jobs do not wait behind avif; polling guidance or `Retry-After` for clients. The queue-age alarm threshold (10 minutes) never fired because the longest wait was under 2 minutes.
