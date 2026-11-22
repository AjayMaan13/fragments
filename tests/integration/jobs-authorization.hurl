# tests/integration/jobs-authorization.hurl
# Jobs belong to the user who created them. Anyone else gets a 404, exactly
# like a job that does not exist, so ids can't be probed.

# 1. User 1 creates a fragment and a job
POST http://localhost:8080/v1/fragments
Content-Type: text/markdown
[BasicAuth]
test-user1@fragments-testing.com:test-password1
`# private`

HTTP/1.1 201
[Captures]
fragment_url: header "Location"

POST {{fragment_url}}/jobs
Content-Type: application/json
[BasicAuth]
test-user1@fragments-testing.com:test-password1
{ "to": ".html" }

HTTP/1.1 202
[Captures]
job_url: header "Location"

# 2. User 2 cannot read that job...
GET {{job_url}}
[BasicAuth]
test-user2@fragments-testing:test-password2

HTTP/1.1 404

# ...nor queue a job against user 1's fragment
POST {{fragment_url}}/jobs
Content-Type: application/json
[BasicAuth]
test-user2@fragments-testing:test-password2
{ "to": ".html" }

HTTP/1.1 404

# 3. Without credentials: 401
GET {{job_url}}

HTTP/1.1 401

# 4. The owner still sees their job
GET {{job_url}}
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 200
