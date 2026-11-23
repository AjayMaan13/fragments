# tests/integration/search.hurl
# Semantic search over the local stack: create text fragments, wait for the worker
# to index them, search, check another user sees nothing, delete and check it is
# gone. (The local stack uses a deterministic fake embedder: it proves the
# plumbing; search quality is measured with the real model in eval/.)

POST http://localhost:8080/v1/fragments
Content-Type: text/plain
[BasicAuth]
test-user1@fragments-testing.com:test-password1
`The zanzibar spice market sells saffron, cardamom and cloves by the kilo.`

HTTP/1.1 201
[Captures]
spice_url: header "Location"

POST http://localhost:8080/v1/fragments
Content-Type: text/markdown
[BasicAuth]
test-user1@fragments-testing.com:test-password1
`# Notes on kernel scheduling and virtual memory paging`

HTTP/1.1 201

# The worker indexes in the background: retry until the spice note is the top hit
GET http://localhost:8080/v1/search?q=saffron%20spice%20market&k=1
[BasicAuth]
test-user1@fragments-testing.com:test-password1
[Options]
retry: 30
retry-interval: 500

HTTP/1.1 200
[Asserts]
jsonpath "$.status" == "ok"
jsonpath "$.query" == "saffron spice market"
jsonpath "$.results" count == 1
jsonpath "$.results[0].snippet" contains "zanzibar"
jsonpath "$.results[0].type" == "text/plain"
jsonpath "$.results[0].score" > 0.3

# Another user cannot find it
GET http://localhost:8080/v1/search?q=saffron%20spice%20market&k=5
[BasicAuth]
test-user2@fragments-testing:test-password2

HTTP/1.1 200
[Asserts]
# the query does not contain "zanzibar", so it only appears in the body if the fragment was found
body not contains "zanzibar"

# Bad requests
GET http://localhost:8080/v1/search?q=
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 400

GET http://localhost:8080/v1/search?q=x&k=99
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 400

GET http://localhost:8080/v1/search?q=x

HTTP/1.1 401

# Deleting the fragment removes it from search
DELETE {{spice_url}}
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 200

GET http://localhost:8080/v1/search?q=saffron%20spice%20market&k=5
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 200
[Asserts]
# the query does not contain "zanzibar", so it only appears in the body if the fragment was found
body not contains "zanzibar"
