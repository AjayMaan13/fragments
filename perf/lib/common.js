// perf/lib/common.js
// Shared helpers for the k6 scripts: where to send requests and how to log in.
//
// Local / CI (docker compose, Basic auth):
//   BASE_URL=http://localhost:8080  (defaults; user = tests/.htpasswd test user)
// Deployed stack (Cognito):
//   AUTH_MODE=cognito BASE_URL=http://<alb-dns> COGNITO_CLIENT_ID=... \
//   COGNITO_USERNAME=... COGNITO_PASSWORD=... AWS_REGION=us-east-2
// The Cognito mode needs the app client to allow ALLOW_USER_PASSWORD_AUTH:
// terraform apply -var enable_password_auth=true (see perf/README.md).

import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import encoding from 'k6/encoding';

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const AUTH_MODE = __ENV.AUTH_MODE || 'basic';

// Returns the Authorization header value for the configured auth mode.
// Call once in setup(), not per iteration: Cognito rate-limits InitiateAuth.
export function authorization() {
  if (AUTH_MODE === 'basic') {
    // These are the committed test credentials in tests/.htpasswd, not secrets
    const user = __ENV.BASIC_USER || 'test-user1@fragments-testing.com';
    const pass = __ENV.BASIC_PASS || 'test-password1';
    return `Basic ${encoding.b64encode(`${user}:${pass}`)}`;
  }

  if (AUTH_MODE === 'cognito') {
    const region = __ENV.AWS_REGION || 'us-east-2';
    for (const name of ['COGNITO_CLIENT_ID', 'COGNITO_USERNAME', 'COGNITO_PASSWORD']) {
      if (!__ENV[name]) fail(`AUTH_MODE=cognito needs ${name}`);
    }
    const res = http.post(
      `https://cognito-idp.${region}.amazonaws.com/`,
      JSON.stringify({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: __ENV.COGNITO_CLIENT_ID,
        AuthParameters: { USERNAME: __ENV.COGNITO_USERNAME, PASSWORD: __ENV.COGNITO_PASSWORD },
      }),
      {
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
        },
        tags: { name: 'cognito InitiateAuth', kind: 'setup' },
      }
    );
    const idToken = res.status === 200 && res.json('AuthenticationResult.IdToken');
    // The API verifies the ID token (not the access token), see src/auth/cognito.js
    if (!idToken) fail(`Cognito login failed: ${res.status} ${res.body}`);
    return `Bearer ${idToken}`;
  }

  return fail(`Unknown AUTH_MODE "${AUTH_MODE}" (use basic or cognito)`);
}

// Wait until the API answers its health check (the stack may still be starting)
export function waitForApi(seconds = 60) {
  for (let i = 0; i < seconds; i++) {
    const res = http.get(`${BASE_URL}/`, { tags: { name: 'health wait', kind: 'setup' } });
    if (res.status === 200) return;
    sleep(1);
  }
  fail(`API at ${BASE_URL} did not become healthy in ${seconds}s`);
}

// Create a fragment and return its id
export function createFragment(authHeader, contentType, body) {
  const res = http.post(`${BASE_URL}/v1/fragments`, body, {
    headers: { Authorization: authHeader, 'Content-Type': contentType },
    tags: { name: 'POST /v1/fragments', kind: 'setup' },
  });
  const ok = check(res, { 'create fragment -> 201': (r) => r.status === 201 });
  if (!ok) fail(`could not create ${contentType} fragment: ${res.status} ${res.body}`);
  return res.json('fragment.id');
}

export function deleteFragment(authHeader, id) {
  return http.del(`${BASE_URL}/v1/fragments/${id}`, null, {
    headers: { Authorization: authHeader },
    tags: { name: 'DELETE /v1/fragments/:id', kind: 'setup' },
  });
}
