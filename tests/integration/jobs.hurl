# tests/integration/jobs.hurl
# Async conversion: queue a job, poll it until the worker has finished, and
# check the result. Needs the worker container and the SQS queue (compose).

# 1. A markdown fragment to convert
POST http://localhost:8080/v1/fragments
Content-Type: text/markdown
[BasicAuth]
test-user1@fragments-testing.com:test-password1
`# Async job`

HTTP/1.1 201
[Captures]
fragment_url: header "Location"

# 2. Ask for it as HTML, as a job. The API answers straight away with 202
POST {{fragment_url}}/jobs
Content-Type: application/json
X-Request-Id: hurl-job-1
[BasicAuth]
test-user1@fragments-testing.com:test-password1
{ "to": ".html" }

HTTP/1.1 202
X-Request-Id: hurl-job-1
[Captures]
job_url: header "Location"
[Asserts]
header "Location" matches "^http://localhost:8080/v1/jobs/"
jsonpath "$.status" == "ok"
jsonpath "$.job.status" == "queued"
jsonpath "$.job.to" == "text/html"
jsonpath "$.job.attempts" == 0
jsonpath "$.job.requestId" == "hurl-job-1"

# 3. Poll until the worker has done it (Hurl retries this request until it passes)
GET {{job_url}}
[BasicAuth]
test-user1@fragments-testing.com:test-password1
[Options]
retry: 30
retry-interval: 500

HTTP/1.1 200
[Asserts]
jsonpath "$.job.status" == "succeeded"
jsonpath "$.job.attempts" == 1
jsonpath "$.job.requestId" == "hurl-job-1"
jsonpath "$.job.result.type" == "text/html"
jsonpath "$.job.result.size" > 0
jsonpath "$.job.result.url" exists
jsonpath "$.job.ownerId" not exists
