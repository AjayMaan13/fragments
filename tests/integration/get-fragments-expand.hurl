# tests/integration/get-fragments-expand.hurl
# Confirm GET /fragments returns bare ids, while ?expand=1 returns full
# fragment metadata objects

# 1. POST a fragment to guarantee there's at least one to list
POST http://localhost:8080/v1/fragments
Content-Type: text/plain
[BasicAuth]
test-user1@fragments-testing.com:test-password1
`expand me`

HTTP/1.1 201
[Captures]
id: jsonpath "$.fragment.id"

# 2. GET /fragments (no expand): should be a list of bare id strings
GET http://localhost:8080/v1/fragments
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 200
[Asserts]
jsonpath "$.status" == "ok"
jsonpath "$.fragments" contains "{{id}}"
jsonpath "$.fragments[0]" isString

# 3. GET /fragments?expand=1: should be full fragment objects
GET http://localhost:8080/v1/fragments?expand=1
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 200
[Asserts]
jsonpath "$.status" == "ok"
jsonpath "$.fragments[?(@.id=='{{id}}')].type" == "text/plain"
jsonpath "$.fragments[?(@.id=='{{id}}')].size" == 9
