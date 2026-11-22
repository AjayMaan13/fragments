// src/queue.js

// The jobs queue (Amazon SQS). Messages are tiny pointers ({ jobId, ownerId });
// everything else lives in the jobs table. The SQS client is created on first
// use so code that never queues anything (and the unit tests) never builds one.

const {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} = require('@aws-sdk/client-sqs');

const queueUrl = () => process.env.AWS_SQS_QUEUE_URL;

// Jobs are only available when a queue is configured
const isEnabled = () => Boolean(queueUrl());

let client;
const getClient = () => {
  if (!client) {
    const config = { region: process.env.AWS_REGION };
    // Like the S3 and DynamoDB clients: explicit endpoint/credentials only when
    // testing against MiniStack; in AWS the task role is picked up automatically
    if (process.env.AWS_SQS_ENDPOINT_URL) config.endpoint = process.env.AWS_SQS_ENDPOINT_URL;
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      config.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      };
    }
    client = new SQSClient(config);
  }
  return client;
};

/**
 * Queue a job. The request id travels as a message attribute so one request can
 * be followed from the API log into the worker log.
 */
async function sendJob({ jobId, ownerId, requestId }) {
  const params = {
    QueueUrl: queueUrl(),
    MessageBody: JSON.stringify({ jobId, ownerId }),
  };
  if (requestId) {
    params.MessageAttributes = {
      requestId: { DataType: 'String', StringValue: String(requestId) },
    };
  }
  await getClient().send(new SendMessageCommand(params));
}

/**
 * Long-poll for messages. Resolves to [] when none arrive within waitSeconds.
 * Each message: { id, body, handle, receiveCount, requestId }
 */
async function receive({ max = 1, waitSeconds = 20 } = {}) {
  const out = await getClient().send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl(),
      MaxNumberOfMessages: max,
      WaitTimeSeconds: waitSeconds,
      AttributeNames: ['ApproximateReceiveCount'],
      MessageAttributeNames: ['requestId'],
    })
  );
  return (out.Messages || []).map((m) => ({
    id: m.MessageId,
    body: m.Body,
    handle: m.ReceiptHandle,
    receiveCount: Number(m.Attributes?.ApproximateReceiveCount) || 1,
    requestId: m.MessageAttributes?.requestId?.StringValue,
  }));
}

// Acknowledge a message: it will not be delivered again
async function remove(handle) {
  await getClient().send(new DeleteMessageCommand({ QueueUrl: queueUrl(), ReceiptHandle: handle }));
}

// Make a message visible again `seconds` from now (0 = immediately)
async function delay(handle, seconds) {
  await getClient().send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl(),
      ReceiptHandle: handle,
      VisibilityTimeout: Math.max(0, Math.round(seconds)),
    })
  );
}

module.exports = { isEnabled, sendJob, receive, remove, delay };
