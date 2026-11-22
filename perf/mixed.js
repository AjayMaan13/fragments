// perf/mixed.js
// Open-model load: requests arrive at a fixed rate whether or not the server
// keeps up (ramping-arrival-rate), which is what exposes queueing and latency
// growth. A staircase of request rates, held for a while each, shows where the
// service stops coping.
//
// Request mix (percent, override with env; they are weights, not required to sum to 100):
//   READ_PCT=80     cheap reads: GET data, GET /info, GET list
//   CONVERT_PCT=15  small conversions: markdown -> pdf / docx
//   IMAGE_PCT=5     heavy conversion: ~2 MP jpeg -> avif
//
// Experiments (see docs/perf/baseline.md):
//   1. Cheap reads only, find the knee:
//        READ_PCT=100 CONVERT_PCT=0 IMAGE_PCT=0 RATES=5,10,20,40,80 k6 run perf/mixed.js
//   2. Same read rate with and without heavy work, compare read p95:
//        RATES=20 STEP_SECONDS=180 k6 run perf/mixed.js                              (80/15/5: 16 reads/s)
//        READ_PCT=100 CONVERT_PCT=0 IMAGE_PCT=0 RATES=16 STEP_SECONDS=180 k6 run perf/mixed.js
//
// Async mode: ASYNC=1 sends the conversions as background jobs (POST /v1/fragments/:id/jobs)
// instead of converting inside the request, so the same mix can be compared
// before and after the async pipeline.
//   WAIT_FOR_JOBS=1  also polls each job to completion and records its end-to-end
//                    time (job_e2e_ms, tagged kind=convert|image). Leave it off to
//                    fire and forget, which keeps iterations short when the worker
//                    cannot keep up. JOB_TIMEOUT_SECONDS (default 300) gives up on a job.
//                    Polling costs the API real capacity (each waiting job is a request per
//                    second), so for latency numbers prefer leaving this off and reading the
//                    jobs' own createdAt/updatedAt afterwards.
//   DRAIN_SECONDS=90 waits before the test fragments are deleted so queued jobs can finish.
//
// Needs perf/fixtures/heavy.jpg: run `node perf/make-fixtures.js` first.
//
// Every request is tagged kind=read|convert|image and step=s0,s1,... (one per
// entry in RATES), so the summary reports each rate step separately.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import exec from 'k6/execution';
import {
  BASE_URL,
  authorization,
  waitForApi,
  createFragment,
  deleteFragment,
} from './lib/common.js';

const HEAVY_IMAGE = open('./fixtures/heavy.jpg', 'b');
const MARKDOWN = `# Load test document

Some **bold** text, a list:

- one
- two
- three

\`\`\`
code block
\`\`\`
`;

const ASYNC = __ENV.ASYNC === '1';
const WAIT_FOR_JOBS = __ENV.WAIT_FOR_JOBS === '1';
const JOB_TIMEOUT_MS = Number(__ENV.JOB_TIMEOUT_SECONDS || 300) * 1000;

// What the caller of a background job experiences: from submitting it until it is done
const jobE2E = new Trend('job_e2e_ms', true);
const jobsSucceeded = new Counter('jobs_succeeded');
const jobsFailed = new Counter('jobs_failed');
const jobsTimedOut = new Counter('jobs_timed_out');

const READ = Number(__ENV.READ_PCT || 80);
const CONVERT = Number(__ENV.CONVERT_PCT || 15);
const IMAGE = Number(__ENV.IMAGE_PCT || 5);
const TOTAL = READ + CONVERT + IMAGE;

// Requests per second at each step, e.g. RATES=5,10,20
const RATES = (__ENV.RATES || '5,10,20,40').split(',').map(Number);
const RAMP_SECONDS = Number(__ENV.RAMP_SECONDS || 10);
const STEP_SECONDS = Number(__ENV.STEP_SECONDS || 60);
const STEP_LENGTH_MS = (RAMP_SECONDS + STEP_SECONDS) * 1000;

const stages = [];
for (const target of RATES) {
  stages.push({ target, duration: `${RAMP_SECONDS}s` });
  stages.push({ target, duration: `${STEP_SECONDS}s` });
}

// k6 only prints sub-metrics (per tag) that a threshold mentions, so add an
// always-true threshold per step to get a p95 and error rate for each step.
const thresholds = {
  http_req_failed: ['rate<0.01'],
  // First-guess target for cheap reads; replace once the baseline is measured
  'http_req_duration{kind:read}': ['p(95)<500'],
};
RATES.forEach((_, i) => {
  thresholds[`http_req_duration{kind:read,step:s${i}}`] = ['p(95)>=0'];
  thresholds[`http_req_failed{step:s${i}}`] = ['rate>=0'];
  thresholds[`http_req_duration{kind:convert,step:s${i}}`] = ['p(95)>=0'];
  thresholds[`http_req_duration{kind:image,step:s${i}}`] = ['p(95)>=0'];
});
if (ASYNC && WAIT_FOR_JOBS) {
  thresholds['job_e2e_ms{kind:convert}'] = ['p(95)>=0'];
  thresholds['job_e2e_ms{kind:image}'] = ['p(95)>=0'];
}

const DRAIN_SECONDS = Number(__ENV.DRAIN_SECONDS || 0);

export const options = {
  scenarios: {
    mixed: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: Number(__ENV.PRE_VUS || 50),
      maxVUs: Number(__ENV.MAX_VUS || 400),
      stages,
    },
  },
  thresholds,
  // teardown deletes the test fragments, after DRAIN_SECONDS in async runs; the default limit is 60 s
  teardownTimeout: `${DRAIN_SECONDS + 60}s`,
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  waitForApi();
  const auth = authorization();
  return {
    auth,
    textId: createFragment(auth, 'text/plain', 'hello from the load test'),
    mdId: createFragment(auth, 'text/markdown', MARKDOWN),
    imageId: createFragment(auth, 'image/jpeg', HEAVY_IMAGE),
  };
}

// ASYNC runs: give the worker time to finish queued jobs before the fragments
// they convert are deleted (a job whose fragment is gone fails immediately)

export function teardown(data) {
  if (ASYNC && DRAIN_SECONDS > 0) sleep(DRAIN_SECONDS);
  for (const id of [data.textId, data.mdId, data.imageId]) deleteFragment(data.auth, id);
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];

// Submit a conversion as a background job and, when WAIT_FOR_JOBS is set, follow it to the end
function runJob(kind, ext, fragmentId, headers, step) {
  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/v1/fragments/${fragmentId}/jobs`,
    JSON.stringify({ to: `.${ext}` }),
    {
      headers: { ...headers, 'Content-Type': 'application/json' },
      tags: { name: `POST /v1/fragments/:id/jobs (.${ext})`, kind, step },
    }
  );
  const accepted = check(res, { 'job accepted -> 202': (r) => r.status === 202 });
  if (!accepted || !WAIT_FOR_JOBS) return;

  const jobId = res.json('job.id');
  while (Date.now() - start < JOB_TIMEOUT_MS) {
    sleep(1);
    const poll = http.get(`${BASE_URL}/v1/jobs/${jobId}`, {
      headers,
      tags: { name: 'GET /v1/jobs/:id', kind: 'poll', step },
    });
    const status = poll.status === 200 ? poll.json('job.status') : 'error';
    if (status === 'succeeded' || status === 'failed') {
      jobE2E.add(Date.now() - start, { kind });
      (status === 'succeeded' ? jobsSucceeded : jobsFailed).add(1, { kind });
      return;
    }
  }
  jobsTimedOut.add(1, { kind });
}

export default function (data) {
  const headers = { Authorization: data.auth };
  const step = `s${Math.min(
    Math.floor(exec.instance.currentTestRunDuration / STEP_LENGTH_MS),
    RATES.length - 1
  )}`;

  const roll = Math.random() * TOTAL;

  if (roll < READ) {
    const read = pick([
      { name: 'GET /v1/fragments/:id', path: `/v1/fragments/${data.textId}` },
      { name: 'GET /v1/fragments/:id/info', path: `/v1/fragments/${data.textId}/info` },
      { name: 'GET /v1/fragments', path: '/v1/fragments' },
    ]);
    const res = http.get(`${BASE_URL}${read.path}`, {
      headers,
      tags: { name: read.name, kind: 'read', step },
    });
    check(res, { 'read -> 200': (r) => r.status === 200 });
  } else if (roll < READ + CONVERT) {
    const ext = pick(['pdf', 'docx']);
    if (ASYNC) return runJob('convert', ext, data.mdId, headers, step);
    const res = http.get(`${BASE_URL}/v1/fragments/${data.mdId}.${ext}`, {
      headers,
      tags: { name: `GET /v1/fragments/:id.${ext}`, kind: 'convert', step },
    });
    check(res, { 'convert -> 200': (r) => r.status === 200 });
  } else {
    if (ASYNC) return runJob('image', 'avif', data.imageId, headers, step);
    const res = http.get(`${BASE_URL}/v1/fragments/${data.imageId}.avif`, {
      headers,
      tags: { name: 'GET /v1/fragments/:id.avif', kind: 'image', step },
    });
    check(res, { 'image convert -> 200': (r) => r.status === 200 });
  }
}
