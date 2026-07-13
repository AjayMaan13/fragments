# tests/integration/post-fragments-charset.hurl
# Posting a fragment with a Content-Type that includes a charset should work,
# and the charset should be preserved when GETting it back.
POST http://localhost:8080/v1/fragments
Content-Type: text/plain; charset=utf-8
[BasicAuth]
test-user1@fragments-testing.com:test-password1
`This is a fragment with a charset!`

HTTP/1.1 201
[Asserts]
jsonpath "$.status" == "ok"
jsonpath "$.fragment.type" == "text/plain; charset=utf-8"
[Captures]
url: header "Location"

# Confirm the GET back reports the same type, including the charset
GET {{url}}
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 200
Content-Type: text/plain; charset=utf-8
[Asserts]
body == "This is a fragment with a charset!"
