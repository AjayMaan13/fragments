# 404 Test
GET http://localhost:8080/no-such-route

# We should get back an HTTP 1.1 404 response for a route that doesn't exist
HTTP/1.1 404
