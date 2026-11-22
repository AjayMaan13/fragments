// src/worker.js

// The queue worker: `node src/worker.js`. The same Docker image as the API,
// started with a different command, running as its own ECS service so slow
// conversions cannot starve the API's request handling.
//
// It handles one message at a time. Conversions are CPU-heavy (a 1080p JPEG to
// AVIF took ~33 s of a 0.25 vCPU task in the load tests), so running several at
// once on one task would only make every job slower.

require('dotenv').config();

const logger = require('./logger');
const queue = require('./queue');
const { processMessage } = require('./worker-core');

if (!queue.isEnabled()) {
  logger.fatal('AWS_SQS_QUEUE_URL is not set; nothing for the worker to do');
  process.exit(1);
}

logger.info('Worker started');

let running = true;
// On a deploy ECS sends SIGTERM. Stop taking new messages and let the job
// in progress finish (the task's stopTimeout gives it time).
const stop = (signal) => {
  logger.info({ signal }, 'Stopping after the current job');
  running = false;
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  while (running) {
    let messages;
    try {
      // Long polling: waits up to 20 s for a message instead of hammering the API
      messages = await queue.receive({ max: 1, waitSeconds: 20 });
    } catch (err) {
      logger.error({ err }, 'Error receiving from the queue, will retry');
      await sleep(5000);
      continue;
    }

    for (const message of messages) {
      try {
        await processMessage(message, { queue });
      } catch (err) {
        // Unexpected (e.g. the jobs table is unreachable). Leave the message: it
        // is redelivered after its visibility timeout and eventually dead-lettered.
        logger.error({ err, messageId: message.id }, 'Unexpected error processing message');
      }
    }
  }
  logger.info('Worker stopped');
}

main().catch((err) => {
  logger.fatal({ err }, 'Worker crashed');
  process.exit(1);
});
