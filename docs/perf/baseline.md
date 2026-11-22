# Baseline load test (v0.9.0)

> **Status: experiments 1, 1b, 2 and 3 run (2026-11-22) on `v0.9.0-rc1`; fixes deployed as `v0.9.0-rc2` and experiments 2 and 3 re-run on it. The memory crashes are fixed; cheap reads are still starved by heavy conversions (Phase 2's job).**
> Every number below comes from a committed k6 summary in this folder or from CloudWatch, and says which.
> Blank means not measured.

## Setup (fill in when run)

| | |
|---|---|
| Date | 2026-11-22 |
| Git commit / image tag | `v0.9.0-rc1` (commit `9f1dd16`) |
| Region | us-east-2 |
| Service | 1 Fargate task, 0.25 vCPU / 512 MB (`infra/modules/ecs/main.tf`) |
| Client | k6 v2.4.0 on a MacBook Air over home internet (client-side latency includes the network, ~20-30 ms floor) |
| Auth | Cognito `USER_PASSWORD_AUTH` |
| Fixtures | text fragment, markdown fragment, `heavy.jpg` (1920x1080, 765 KiB; only used by experiment 2) |

How to run each experiment: [`perf/README.md`](../../perf/README.md).

## Experiment 1: cheap reads, where does it break?

**Run in two passes: 5-80 req/s here (clean), 100-250 req/s in "Experiment 1b" below (saturated).**

Command: `READ_PCT=100 CONVERT_PCT=0 IMAGE_PCT=0 RATES=5,10,20,40,80` (each step: 10 s ramp, 60 s hold), 10,462 requests in total.
Summary: [`exp1-reads-to-80rps.json`](exp1-reads-to-80rps.json). Reads are `GET /v1/fragments/:id`, `/info` and the list, equally weighted.

| Step (req/s) | read p50 | read p95 | read p99 | failed / total | ECS CPU (1-min avg, max) |
|---|---|---|---|---|---|
| 5 | 32 ms | 73 ms | 94 ms | 0 / 325 | 6%, 14% |
| 10 | 31 ms | 64 ms | 77 ms | 0 / 671 | 12%, 14% |
| 20 | 31 ms | 67 ms | 189 ms | 0 / 1,341 | 17-30%, 35% |
| 40 | 30 ms | 65 ms | 147 ms | 0 / 2,683 | 46%, 54% |
| 80 | 29 ms | 90 ms | 224 ms | 1 / 5,434 (0.018%) | 55%, 76% |

Client-side latencies (k6, includes the internet round trip). ALB-side `TargetResponseTime` p95 for the same minutes was 38-42 ms up to 40 req/s and 64 ms in the 80 req/s minute (CloudWatch). CPU is the ECS service `CPUUtilization` for the minute containing each step (steps straddle minute boundaries, so treat these as approximate). Memory peaked at 18%.

What this shows:
- Up to 80 req/s, cheap reads stayed at roughly 30 ms median and under 100 ms p95, with an error rate of 0.0096% overall (1 of 10,462). Both thresholds in `mixed.js` (`http_req_failed < 1%`, read p95 < 500 ms) passed.
- CPU, not memory, is what climbs with load: about 55% average (76% peak) at 80 req/s on the 0.25 vCPU task. That leaves headroom, so the first limit is probably well above 80 req/s.
- k6 reported no dropped iterations and never needed more than its 50 pre-allocated VUs, so the load generator was not the limit.

Open item:
- **The single failure** was an ALB-generated 5xx (`HTTPCode_ELB_5XX_Count` = 1, in the 80 req/s minute). The target returned no 5xx and the app logged no errors. Hypothesis, **not confirmed**: Node's default `keepAliveTimeout` is 5 s while the ALB idle timeout is 60 s, a known source of rare ALB 502s. `src/server.js` does not set it. One event in 10,462 cannot confirm or refute this.

### Experiment 1b: 100-250 req/s (the task saturates)

Command: same as above with `RATES=100,150,200,250`. Summary: [`exp1b-reads-100-250rps.json`](exp1b-reads-100-250rps.json). k6 exited 99 (thresholds crossed).

| Offered rate (req/s) | requests actually sent | read p50 | read p95 | read p99 | failed |
|---|---|---|---|---|---|
| 100 | 6,037 of ~6,505 | 634 ms | 18.0 s | 39.4 s | 4 (0.1%) |
| 150 | 7,883 of ~10,250 | 1.2 s | 38.0 s | 60.0 s | 140 (1.8%) |
| 200 | 4,516 of ~13,750 | 1.6 s | 60.0 s | 60.0 s | 372 (8.2%) |
| 250 | 5,731 of ~17,250 | 1.5 s | 10.0 s | 26.0 s | 97 (1.7%) |

The rate column is the load k6 tried to offer, not what the server handled. Once responses slowed, k6 hit its 400-VU cap and **dropped 23,587 iterations** (24,175 sent + 23,587 dropped is about the 47,755 offered). The ALB's busiest minute was 6,585 requests (about 110 req/s).
Server side (CloudWatch, 1-minute): ECS CPU averaged **100%** in the minute that held the 100 req/s step; memory peaked at 32%. `TargetResponseTime` p95 was 1.9 s, 4.5 s, 26.4 s, 3.3 s and 3.0 s in successive minutes (vs about 40 ms below 40 req/s).

Findings (measured unless marked):
1. **Throughput ceiling is about 100 req/s of cheap reads on one 0.25 vCPU task, and it is CPU-bound.** Memory never passed 32%. Between 80 req/s (clean: p95 90 ms, CPU 55% average) and 100 req/s (p95 18 s, CPU 100%) it falls over, so the breaking point is somewhere in 80-100 req/s. Finer steps (for example 85, 90, 95) would narrow it.
2. **Error rate alone hides the breaking point.** The first step with more than 1% failures was 150 req/s, but at 100 req/s the p95 was already 18 s with only 0.1% of requests failing. Latency, not error rate, is the right SLO to watch.
3. **Overload makes the task unhealthy and ECS replaces it.** `UnHealthyHostCount` reached 1 (10:52 and 10:55), the target showed `unhealthy / Target.Timeout`, ECS stopped the task at 10:53:35, and at 10:55:52 started another "due to an unhealthy status". With one task, each replacement means no healthy target, and the ALB generated 120 5xx responses (4 + 36 + 80). (Likely, not confirmed: the health check `GET /` times out because the single Node event loop is saturated.)
4. **The `5xx-rate` alarm design has a gap.** It watches `HTTPCode_Target_5XX_Count`, which was **0** for the whole run. The failures were ALB-generated 5xx plus client-side 60 s timeouts (max latency 60,001 ms), which that alarm cannot see. It stayed OK throughout. To fix: also count `HTTPCode_ELB_5XX_Count`.

## Experiment 2: cheap-read p95 with and without heavy conversions

The number Phase 2 (async pipeline) has to improve. Both runs carry the **same 16 cheap reads/s** for 3 minutes (plus a 10 s ramp).
Summaries: [`exp2-reads-only-16rps.json`](exp2-reads-only-16rps.json), [`exp2-mixed-20rps.json`](exp2-mixed-20rps.json).

| Run | requests sent | cheap-read p50 | cheap-read p95 | cheap-read p99 | failed |
|---|---|---|---|---|---|
| reads only, 16 req/s (`READ_PCT=100 RATES=16`) | 2,972 | 31 ms | **63 ms** | 97 ms | 0 / 2,972 |
| mix 80% reads / 15% pdf+docx / 5% avif, 20 req/s (16 reads + 3 + 1 per s) | 2,291 (1,296 more dropped by k6) | 10.0 s | **60.0 s** (k6's 60 s timeout; true value is higher) | 60.0 s | 994 / 2,291 (43%) |

Heavy requests in the mixed run (client-side, same run):

| Kind | p50 | p95 | succeeded |
|---|---|---|---|
| small conversion (md to pdf/docx) | 31.8 s | 60.0 s | 186 / 339 |
| heavy conversion (1080p jpeg to avif) | 60.0 s | 60.0 s | **0 / 111** |

Server side during the mixed run (CloudWatch): ECS CPU 100% average in the busiest minute; **memory 30% to 80% to 91% to 97% (max 99%)**, then the task died (below); ALB 5xx 255 (18 + 237), target 5xx 0.

Single requests on an idle task (one at a time, curl from the laptop, includes the internet round trip):

| Request | Time |
|---|---|
| jpeg to avif (`heavy.jpg`, 1920x1080, 765 KiB) | **33.0 s, 32.5 s, 32.3 s** |
| markdown to pdf | 0.97 s (first, cold), 0.13 s, 0.12 s |
| raw read | 0.14 s, 0.13 s |

Findings (measured unless marked):
1. **Cheap-read p95 goes from 63 ms to at least 60 s when 20% of the traffic is conversions.** This is the before number for Phase 2. The 60 s is a floor (k6's timeout), not the real p95.
2. **One avif conversion costs about 32 s of this task's CPU**, so it is the dominant cost: even one avif every 30 s uses the whole 0.25 vCPU. At 1 avif/s (5% of 20 req/s) the offered work is roughly 30x what the task can do, hence 0 of 111 finishing. The pdf/docx share was not tested alone, so how much it contributed is unknown.
3. **The overload killed the service twice in this experiment.** ECS stopped one task for failing ELB health checks (11:16:38). Its replacement, started at 11:16:35, was **OOM-killed (exit code 137, "container killed due to memory usage") at about 11:18:59**, after k6 had already finished at 11:17:58. The ALB returned 502 and then 504 until a new task passed health checks at 11:19:49, roughly four minutes of degraded or no service. Likely, not confirmed: requests the clients had already abandoned kept running on the server (a conversion is not cancelled when the client disconnects), so work piled up after the test ended.
4. **Memory exhaustion is real, and it does not need a huge-pixel image.** It happened with ordinary 765 KiB 1080p jpegs, through concurrency alone. The dashboard's memory widget showed 91-99% from 11:17, but the `ecs-memory` alarm (threshold 80%, 2 consecutive minutes) only went to ALARM at **11:21:35**, about 3 minutes after the task had already been OOM-killed. ECS metrics reach CloudWatch with a lag of a few minutes, so this alarm is too slow to prevent an OOM kill; it only reports one.
5. **Implication for Phase 2:** the worker will also be slow on avif at 0.25 vCPU (about 32 s a job), so job latency, worker size or a lower `sharp` avif effort need deciding there, and the "heavy" fraction used for the before/after comparison should be re-chosen (5% avif at 20 req/s overwhelms any single small task and makes the "before" unusable as a gradual curve).

### Experiment 2 re-run on the fixed build (`v0.9.0-rc2`)

Same method as above (16 reads/s alone, then the 80/15/5 mix at 20 req/s, 3 minutes each), run about 40 minutes after deploying the fixes.
Summaries: [`exp2fix-reads-only-16rps.json`](exp2fix-reads-only-16rps.json), [`exp2fix-mixed-20rps.json`](exp2fix-mixed-20rps.json).

| | rc1 (before) | rc2 (after) |
|---|---|---|
| reads only, 16 req/s: read p50 / p95 / p99 | 31 / 63 / 97 ms | 31 / 70 / 137 ms |
| reads only: failed | 0 / 2,972 | 0 / 2,972 |
| mix: cheap-read p50 | 10.0 s | 6.1 s |
| mix: cheap-read p95 | 60.0 s (timeout floor) | **60.0 s (timeout floor)** |
| mix: failed requests | 994 / 2,291 (43%) | 1,153 / 2,924 (39%) |
| mix: avif conversions that finished | 0 / 111 | 0 / 144 |
| mix: iterations k6 had to drop | 1,296 | 782 |
| mix: peak ECS memory | 99% (OOM kill, exit 137) | **63%, no OOM** |
| mix: peak ECS CPU | 100% | 100% |
| mix: task killed? | yes, twice (health checks, then OOM) | yes, once, **for failing ELB health checks (no OOM)** |

Also on rc2: the busy limit shed **114 image requests with a 503** (app log "Busy converting other images"), and the load balancer generated another 459 5xx while the task was unresponsive (13 + 445 + 1). The reads-only run showed no regression from the fixes or the keep-alive change (p95 63 ms to 70 ms is within run-to-run noise; not tested for significance).

Findings:
1. **The memory crashes are fixed.** Memory peaked at 63% instead of 99% and no container was OOM-killed. The huge-pixel case is fixed too (experiment 3 below).
2. **The fixes do not protect cheap reads, and I should not claim they do.** Cheap-read p95 is still at k6's 60 s timeout floor, a third of requests still fail, and no avif conversion finishes. Reason: the bottleneck is **CPU**, not memory. Two concurrent avif conversions (the limit allows 2) take all of the 0.25 vCPU for about a minute each, so the single Node process serving reads (and health checks) gets almost none. That is why ECS still killed the task for failing health checks.
3. **This is the number Phase 2 had to beat** (and the result is in [`async.md`](async.md): cheap-read p95 67 ms and 0% failures with the same mix): cheap-read p95 of **at least 60 s** (floor) and ~39% failures with the 80/15/5 mix, versus **70 ms and 0% failures** with the same reads alone. Isolating heavy work from the request path (a separate worker) is the actual fix; the limits in `src/convert.js` are a safety net that stops crashes, not a performance fix.
4. **The widened `5xx-rate` alarm works.** In this run it went to **ALARM at 12:12:58 EST**, about 4 minutes after the worst minute (12:09: 1,357 requests, 467 5xx, 34%). The same kind of overload left the old alarm silent. The 4-minute delay is CloudWatch's metric lag plus the 2-of-3-minutes rule.

## Experiment 3: memory with a small file of huge pixel dimensions

Hypothesis: a PNG of a few hundred KB but ~256 megapixels can exhaust the 512 MB task when `sharp` decodes it.
**Confirmed: one request killed the container.**

| Input | Request | HTTP result | Container | Service impact |
|---|---|---|---|---|
| 16000x16000 solid-colour PNG, 758 KiB (256 megapixels, under sharp's default 268 M pixel limit) | one `GET /v1/fragments/:id.avif` on an idle, healthy task | **502 after 2.0 s** | **OOM-killed, exit code 137, "container killed due to memory usage"** (ECS recorded the stop at 11:27:15) | API returned 502 then 503 from about 11:27:05 until 11:28:02: roughly one minute with no healthy target. A replacement task started on its own. |

Upload of the file itself succeeded (`POST` 201 in 0.3 s): the API accepts it because it is under the 5 MB body limit.
The fragment was deleted afterwards (200, then 404) so nothing could re-trigger the crash.

What this shows:
- **Any authenticated user can take the service down with one small request.** The cost is set by pixel dimensions, not file size, and the 5 MB limit does not stop it. (Real, measured. Whether lower pixel counts also kill the task, and where the threshold is, was not tested.)
- Together with experiment 2 there are now two independent ways to OOM the 512 MB task: **one huge-pixel image** (this experiment) and **concurrent ordinary image conversions** (experiment 2).
- **Fixes written (local only, not yet deployed or re-measured):**
  - `src/convert.js`: images over `MAX_IMAGE_PIXELS` (default 16 MP) are refused with `422` from the image header, before decoding. The exact production crash input (16000x16000 PNG) now returns 422 in 20 ms against a local container that stays at 64 MiB.
  - At most `MAX_CONCURRENT_IMAGE_CONVERSIONS` (default 2) image conversions run at once; extra requests get `503` + `Retry-After: 5`.
  - `src/server.js`: `keepAliveTimeout` raised above the ALB idle timeout (hypothesis from experiment 1; not proven).
  - `5xx-rate` alarm now also counts load-balancer-generated 5xx.
  - Tests: 11 new unit tests, 4 route tests, a Hurl case with a committed 6000x6000 fixture.
- **After the fix (`v0.9.0-rc2` deployed 2026-11-22, same 16000x16000 PNG, one request each):** `GET /v1/fragments/:id.avif` returned **422 in 0.25 s** and `?width=100` returned 422 in 0.14 s, with the message "Image is too large to convert (16000x16000); the limit is 16 megapixels". The ECS task id did not change (no restart) and `GET /` stayed 200. The test fragment was deleted afterwards. Before: 502 after 2.0 s and an OOM-killed container.
- **Still to do:** re-run experiment 2 on the fixed build and record before/after here. The 16 MP default is a cautious guess, not a measured threshold: where between 2 MP (worked) and 256 MP (crashed) the 512 MB task actually fails was never measured.

## Alarm drill

Triggered by the experiment 1b and 2 overloads rather than a dedicated drill (needed for the Phase 1 Definition of Done):

| Alarm | How triggered | Result |
|---|---|---|
| `fragments-p95-latency` | experiment 1b: p95 `TargetResponseTime` 4.5 s then 26.4 s (threshold 3 s, 2 of 3 minutes) | **Went to ALARM at 10:56:52 EST**, about 4 minutes after the latency breach began (CloudWatch alarm history). Email receipt: **not yet confirmed**. |
| `fragments-5xx-rate` | experiment 1b: stayed OK, target 5xx was 0 (finding 4 there). Experiment 2 re-run on rc2 (alarm now counts ELB 5xx too): minutes at 5.3% and 34.4% | **ALARM at 12:12:58 EST** in the re-run (CloudWatch alarm history). Email receipt not confirmed. |
| `fragments-unhealthy-hosts` | same run | Stayed OK at last check; `UnHealthyHostCount` hit 1 at 10:52 and 10:55 but not in two consecutive minutes |
| `fragments-ecs-memory` | experiment 1b: stayed OK (memory peaked at 32%). Experiment 2: memory 91-99% (11:17-11:18) | **ALARM at 11:21:35 EST** in experiment 2, after the task was already killed (see experiment 2, finding 4). Email receipt not confirmed. |
