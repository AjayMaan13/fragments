# Observability

Terraform module: `infra/modules/observability`. Created and destroyed with the rest of the stack.

## What exists

| Thing | Where | Notes |
|---|---|---|
| Dashboard `fragments-overview` | CloudWatch (`terraform output dashboard_url`) | Requests, 5xx, p50/p95/p99 latency, healthy/unhealthy targets, ECS CPU and memory, conversion duration by target type, job queue depth and oldest waiting job, job end-to-end latency, worker CPU and memory, recent errors |
| Alarms (6) | CloudWatch, notify SNS topic `fragments-alarms` | `5xx-rate` (app 5xx plus load-balancer-generated 5xx), `p95-latency`, `unhealthy-hosts`, `ecs-memory`, `jobs-dlq-not-empty` (any dead-lettered job), `jobs-oldest-message-age` (a job waiting over 10 min: worker down or behind) |
| `JobDuration` / `JobEndToEnd` metrics | namespace `Fragments`, dimension `TargetType` | Written by the worker per finished job: conversion time, and queued + converting time (what the caller waits) |
| `ConversionDuration` metric | namespace `Fragments`, dimension `TargetType` | Written as Embedded Metric Format log lines by `src/metrics.js` (no PutMetricData, no IAM change) |
| Request IDs | `X-Request-Id` header, `req.id` on every log line | Honors a valid incoming id, otherwise generates a UUID (`src/request-id.js`). A job carries its request id in the queue message and the worker logs it as `requestId`, so one request can be followed from the API into the worker |

Alarm email: set `-var alarm_email=you@example.com` and click the confirmation link AWS sends.
Without it the alarms exist but notify nobody.

## Following one request

```bash
curl -H "X-Request-Id: demo-123" -H "Authorization: Bearer $TOKEN" "$API/v1/fragments"
```

Then in CloudWatch Logs Insights on `/ecs/fragments-task`:

```
fields @timestamp, msg, req.method, req.url, res.statusCode
| filter req.id = "demo-123"
```

## Service level indicators and objectives

The stack is destroyed between sessions, so **there is no uptime SLO**. The SLOs are about
behaviour while the stack is up, and only meaningful under a stated load.

| SLI | Definition | Target |
|---|---|---|
| Availability | requests without a 5xx from the app / all requests (`HTTPCode_Target_5XX_Count` / `RequestCount`) | **to be set from the baseline** |
| Cheap-read latency | p95 of `GET /v1/fragments[/:id[/info]]`, measured by k6 (`kind:read`) | **to be set from the baseline** |

Targets are deliberately blank until `docs/perf/baseline.md` has real numbers. Until then the alarm
thresholds in `infra/modules/observability/variables.tf` are generous first guesses
(5% 5xx, p95 3 s, 80% memory), not SLOs.

Note the ALB `TargetResponseTime` on the dashboard mixes cheap reads with slow conversions, so it
overstates cheap-read latency. The per-kind p95 comes from the k6 tags, which is why the baseline
is measured with k6 rather than read off the dashboard.

## Known limits

- The `ecs-memory` alarm is slow: ECS metrics reach CloudWatch a few minutes late, so in the load tests it fired about 3 minutes after the task had already been OOM-killed. It reports a memory problem; it cannot prevent one. The limits in `src/convert.js` are what protect the task.
- The `5xx-rate` alarm originally counted only app (target) 5xx and stayed silent while the load balancer returned hundreds of 5xx during an overload. It now counts both (changed after the load tests; not yet re-verified on AWS).
- The dashboard and the original four alarms were applied to AWS on 2026-11-22 and worked: AWS accepted the dashboard JSON, the `ConversionDuration` metric appeared for pdf and docx, and the `p95-latency` and `ecs-memory` alarms fired during load tests. Only the widened `5xx-rate` expression is still unverified on AWS.
- EMF metrics are emitted at log level `info`; `FRAGMENTS_LOG_LEVEL=warn` or higher switches them off.
- Alarms use `treat_missing_data = notBreaching`, so an idle or scaled-to-zero service does not alarm.
