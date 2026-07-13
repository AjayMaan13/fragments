# tests/integration/lab-9-s3.hurl
# End-to-end test of POST -> GET -> DELETE -> GET (404) against S3-backed storage

# 1. POST a new text fragment as an authorized user
POST http://localhost:8080/v1/fragments
Content-Type: text/plain
[BasicAuth]
test-user1@fragments-testing.com:test-password1
`Hello S3!`

# 2. Confirm we get back a 201, and capture the Location URL
HTTP/1.1 201
[Asserts]
jsonpath "$.status" == "ok"
jsonpath "$.fragment.type" == "text/plain"
[Captures]
url: header "Location"

# 3. GET the fragment we just created
GET {{url}}
[BasicAuth]
test-user1@fragments-testing.com:test-password1

# 4. Confirm a 200, the correct type, and the expected body
HTTP/1.1 200
Content-Type: text/plain
[Asserts]
body == "Hello S3!"

# 5. DELETE the fragment
DELETE {{url}}
[BasicAuth]
test-user1@fragments-testing.com:test-password1

# 6. Confirm the delete succeeded
HTTP/1.1 200
[Asserts]
jsonpath "$.status" == "ok"

# 7. Try to GET the fragment again
GET {{url}}
[BasicAuth]
test-user1@fragments-testing.com:test-password1

# 8. Confirm it's gone
HTTP/1.1 404
