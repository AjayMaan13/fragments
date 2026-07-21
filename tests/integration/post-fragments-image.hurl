# tests/integration/post-fragments-image.hurl
# POST an image fragment, GET it back byte-identical, then convert it to
# another image format via the .ext route

# 1. POST a PNG fragment
POST http://localhost:8080/v1/fragments
Content-Type: image/png
[BasicAuth]
test-user1@fragments-testing.com:test-password1
file,fixtures/test.png;

HTTP/1.1 201
[Asserts]
jsonpath "$.status" == "ok"
jsonpath "$.fragment.type" == "image/png"
jsonpath "$.fragment.size" == 68
[Captures]
url: header "Location"

# 2. GET it back and confirm it's the same PNG bytes
GET {{url}}
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 200
[Asserts]
header "Content-Type" contains "image/png"
bytes == file,fixtures/test.png;

# 3. Convert it to JPEG via the .jpg extension
GET {{url}}.jpg
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 200
Content-Type: image/jpeg
[Asserts]
# JPEG files start with the bytes FF D8
bytes startsWith hex,ffd8;
