# tests/integration/jobs-validation.hurl
# Bad job requests are rejected before anything is queued.

POST http://localhost:8080/v1/fragments
Content-Type: text/plain
[BasicAuth]
test-user1@fragments-testing.com:test-password1
`plain text`

HTTP/1.1 201
[Captures]
fragment_url: header "Location"

# Unknown target extension
POST {{fragment_url}}/jobs
Content-Type: application/json
[BasicAuth]
test-user1@fragments-testing.com:test-password1
{ "to": ".exe" }

HTTP/1.1 400

# text/plain cannot become an image
POST {{fragment_url}}/jobs
Content-Type: application/json
[BasicAuth]
test-user1@fragments-testing.com:test-password1
{ "to": ".avif" }

HTTP/1.1 415

# width only applies to images
POST {{fragment_url}}/jobs
Content-Type: application/json
[BasicAuth]
test-user1@fragments-testing.com:test-password1
{ "to": ".pdf", "width": 100 }

HTTP/1.1 400

# Unknown fragment
POST http://localhost:8080/v1/fragments/no-such-fragment/jobs
Content-Type: application/json
[BasicAuth]
test-user1@fragments-testing.com:test-password1
{ "to": ".pdf" }

HTTP/1.1 404

# Unknown job
GET http://localhost:8080/v1/jobs/no-such-job
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 404
