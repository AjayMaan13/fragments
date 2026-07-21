# tests/integration/put-fragments.hurl
# Create a fragment, update it, confirm the new data is returned, then
# exercise the error cases: type mismatch (400) and unknown id (404)

# 1. POST a new text fragment
POST http://localhost:8080/v1/fragments
Content-Type: text/plain
[BasicAuth]
test-user1@fragments-testing.com:test-password1
`Original content`

HTTP/1.1 201
[Asserts]
jsonpath "$.status" == "ok"
[Captures]
url: header "Location"
id: jsonpath "$.fragment.id"

# 2. PUT new data with the same Content-Type
PUT {{url}}
Content-Type: text/plain
[BasicAuth]
test-user1@fragments-testing.com:test-password1
`Updated content, now longer than before`

HTTP/1.1 200
[Asserts]
jsonpath "$.status" == "ok"
jsonpath "$.fragment.id" == "{{id}}"
jsonpath "$.fragment.type" == "text/plain"
jsonpath "$.fragment.size" == 39

# 3. GET the fragment back and confirm the data was actually updated
GET {{url}}
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 200
Content-Type: text/plain
[Asserts]
body == "Updated content, now longer than before"

# 4. PUT with a different Content-Type should be rejected (type is immutable)
PUT {{url}}
Content-Type: application/json
[BasicAuth]
test-user1@fragments-testing.com:test-password1
`{"a":1}`

HTTP/1.1 400

# 5. PUT to a fragment id that doesn't exist should 404
PUT http://localhost:8080/v1/fragments/does-not-exist
Content-Type: text/plain
[BasicAuth]
test-user1@fragments-testing.com:test-password1
`nope`

HTTP/1.1 404
