# tests/integration/get-conversions.hurl
# Exercise the .ext conversion routes: markdown->html, json->yaml, csv->json,
# and confirm an unsupported conversion is rejected with 415

# 1. POST a markdown fragment
POST http://localhost:8080/v1/fragments
Content-Type: text/markdown
[BasicAuth]
test-user1@fragments-testing.com:test-password1
`# Hello`

HTTP/1.1 201
[Captures]
md_url: header "Location"

# 2. GET it as .html
GET {{md_url}}.html
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 200
[Asserts]
header "Content-Type" contains "text/html"
body == "<h1>Hello</h1>\n"

# 3. POST a JSON fragment
POST http://localhost:8080/v1/fragments
Content-Type: application/json
[BasicAuth]
test-user1@fragments-testing.com:test-password1
`{"hello":"world"}`

HTTP/1.1 201
[Captures]
json_url: header "Location"

# 4. GET it as .yaml
GET {{json_url}}.yaml
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 200
[Asserts]
header "Content-Type" contains "application/yaml"
body contains "hello: world"

# 5. POST a CSV fragment
POST http://localhost:8080/v1/fragments
Content-Type: text/csv
[BasicAuth]
test-user1@fragments-testing.com:test-password1
```
name,age
alice,30
```

HTTP/1.1 201
[Captures]
csv_url: header "Location"

# 6. GET it as .json
GET {{csv_url}}.json
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 200
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$[0].name" == "alice"
jsonpath "$[0].age" == "30"

# 7. Requesting an unsupported conversion (.html on a plain text fragment) is 415
POST http://localhost:8080/v1/fragments
Content-Type: text/plain
[BasicAuth]
test-user1@fragments-testing.com:test-password1
`plain text`

HTTP/1.1 201
[Captures]
txt_url: header "Location"

GET {{txt_url}}.html
[BasicAuth]
test-user1@fragments-testing.com:test-password1

HTTP/1.1 415
