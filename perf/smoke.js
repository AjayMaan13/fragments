// perf/smoke.js
// A quick end-to-end check that the API works under k6 at all: health, create,
// read back, delete, confirm gone. Runs in CI against the docker compose stack
// and by hand against a deployed one. It is a smoke test, not a benchmark, so
// the latency threshold is deliberately generous (CI runners are noisy).
//
//   k6 run perf/smoke.js
//   k6 run --summary-export=perf/results/smoke.json perf/smoke.js

import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, authorization, waitForApi } from './lib/common.js';

export const options = {
  vus: 1,
  iterations: 10,
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<2000'],
    checks: ['rate==1'],
  },
};

export function setup() {
  waitForApi();
  return { auth: authorization() };
}

export default function (data) {
  const headers = { Authorization: data.auth };
  const text = `smoke ${Date.now()}`;

  const health = http.get(`${BASE_URL}/`, { tags: { name: 'GET /' } });
  check(health, {
    'health -> 200': (r) => r.status === 200,
    'health status ok': (r) => r.json('status') === 'ok',
  });

  const created = http.post(`${BASE_URL}/v1/fragments`, text, {
    headers: { ...headers, 'Content-Type': 'text/plain' },
    tags: { name: 'POST /v1/fragments' },
  });
  check(created, {
    'create -> 201': (r) => r.status === 201,
    'create has Location': (r) => Boolean(r.headers['Location']),
  });
  const id = created.json('fragment.id');

  const got = http.get(`${BASE_URL}/v1/fragments/${id}`, {
    headers,
    tags: { name: 'GET /v1/fragments/:id' },
  });
  check(got, {
    'get -> 200': (r) => r.status === 200,
    'get returns what we stored': (r) => r.body === text,
  });

  const deleted = http.del(`${BASE_URL}/v1/fragments/${id}`, null, {
    headers,
    tags: { name: 'DELETE /v1/fragments/:id' },
  });
  check(deleted, { 'delete -> 200': (r) => r.status === 200 });

  // 404 is the expected answer here, so don't count it as a failed request
  const gone = http.get(`${BASE_URL}/v1/fragments/${id}`, {
    headers,
    tags: { name: 'GET /v1/fragments/:id (deleted)' },
    responseCallback: http.expectedStatuses(404),
  });
  check(gone, { 'get after delete -> 404': (r) => r.status === 404 });
}
