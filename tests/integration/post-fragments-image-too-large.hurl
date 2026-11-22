# tests/integration/post-fragments-image-too-large.hurl
# A small PNG file that decodes to 36 megapixels (6000x6000, ~tens of KB on disk).
# Upload is allowed, but converting or resizing it is refused with a 422 instead
# of exhausting the server's memory (this shape of file used to kill the
# production container, see docs/perf/baseline.md). The raw bytes still download.

# 1. POST the PNG fragment
POST http://localhost:8080/v1/fragments
Content-Type: image/png
[BasicAuth]
test-user1@fragments-testing.com:test-password1
file,fixtures/huge-pixels.png;

HTTP/1.1 201
[Captures]
url: header "Location"

# 2. Converting it is refused
GET {{url}}.webp
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 422
[Asserts]
jsonpath "$.status" == "error"
jsonpath "$.error.code" == 422
jsonpath "$.error.message" contains "too large"

# 3. So is resizing it
GET {{url}}?width=100
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 422

# 4. But the original bytes can still be downloaded
GET {{url}}
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 200
Content-Type: image/png
