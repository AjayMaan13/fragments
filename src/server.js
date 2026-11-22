// src/server.js

// We want to gracefully shutdown our server
const stoppable = require('stoppable');

// Get our logger instance
const logger = require('./logger');

// Get our express app instance
const app = require('./app');

// Get the desired port from the process' environment. Default to `8080`
const port = parseInt(process.env.PORT || '8080', 10);

// Start a server listening on this port
const server = stoppable(
  app.listen(port, () => {
    // Log a message that the server has started, and which port it's using.
    logger.info(`Server started on port ${port}`);
  })
);

// Behind an AWS load balancer, Node must keep idle connections open LONGER than
// the load balancer does (its idle timeout is 60 s). Node's default is 5 s, so
// the server can close a connection just as the load balancer reuses it, which
// shows up as a rare ALB-generated 502 with nothing in the app logs. Load testing
// saw one such 5xx in 10,462 requests (docs/perf/baseline.md); this is the
// standard remedy, not yet proven to be the cause. headersTimeout must stay above it.
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

// Export our server instance so other parts of our code can access it if necessary.
module.exports = server;
