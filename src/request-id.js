// src/request-id.js

// Request correlation: reuse the caller's X-Request-Id when it is sane,
// otherwise make one up, and always send it back. pino-http then stamps it on
// every log line for the request (as `req.id`), so one request can be followed
// through CloudWatch Logs (and, later, through queue messages to a worker).

const { randomUUID } = require('crypto');

// Only accept short, boring IDs: the value ends up in logs and a response
// header, so anything with spaces/newlines/odd characters is replaced.
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

const HEADER = 'X-Request-Id';

// Shape expected by pino-http's `genReqId` option
function genReqId(req, res) {
  const incoming = req.headers['x-request-id'];
  const id =
    typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(HEADER, id);
  return id;
}

module.exports = { genReqId, HEADER };
