# tests/integration/post-fragments-unsupported-type.hurl
# Posting an unsupported Content-Type should be rejected
POST http://localhost:8080/v1/fragments
Content-Type: application/msword
[BasicAuth]
test-user1@fragments-testing.com:test-password1
`nope`

# We expect an HTTP 415 Unsupported Media Type
HTTP/1.1 415
