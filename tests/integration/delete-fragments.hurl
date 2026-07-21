# tests/integration/delete-fragments.hurl
# DELETE error cases: unauthenticated (401) and unknown id (404)

# 1. Unauthenticated DELETE is denied
DELETE http://localhost:8080/v1/fragments/some-id

HTTP/1.1 401

# 2. DELETE of an unknown fragment id returns 404
DELETE http://localhost:8080/v1/fragments/does-not-exist
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 404
