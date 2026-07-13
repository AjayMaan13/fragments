# tests/integration/post-fragments-unauthenticated.hurl
# Posting a fragment with no credentials should be denied
POST http://localhost:8080/v1/fragments
Content-Type: text/plain
`This should not be allowed`

# We expect an HTTP 401 Unauthorized
HTTP/1.1 401
