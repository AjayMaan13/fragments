# tests/integration/jobs-failure.hurl
# A job that cannot succeed ends in `failed` with the reason, instead of
# retrying for ever or crashing the worker. fixtures/huge-pixels.png is a small
# file that decodes to 36 megapixels, over the 16 MP limit.

POST http://localhost:8080/v1/fragments
Content-Type: image/png
[BasicAuth]
test-user1@fragments-testing.com:test-password1
file,fixtures/huge-pixels.png;

HTTP/1.1 201
[Captures]
fragment_url: header "Location"

POST {{fragment_url}}/jobs
Content-Type: application/json
[BasicAuth]
test-user1@fragments-testing.com:test-password1
{ "to": ".webp" }

HTTP/1.1 202
[Captures]
job_url: header "Location"

GET {{job_url}}
[BasicAuth]
test-user1@fragments-testing.com:test-password1
[Options]
retry: 30
retry-interval: 500

HTTP/1.1 200
[Asserts]
jsonpath "$.job.status" == "failed"
jsonpath "$.job.error" contains "too large"
# permanent errors are not retried
jsonpath "$.job.attempts" == 1
jsonpath "$.job.result" not exists
