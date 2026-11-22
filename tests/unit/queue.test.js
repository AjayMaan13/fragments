// tests/unit/queue.test.js

// The SQS wrapper: what it sends to SQS and how it reads the answers. The AWS
// SDK is mocked; the real thing is exercised against MiniStack by the Hurl tests.

const mockSend = jest.fn();
const mockClientConfigs = [];

jest.mock('@aws-sdk/client-sqs', () => {
  const command = (name) =>
    class {
      constructor(input) {
        this.name = name;
        this.input = input;
      }
    };
  return {
    SQSClient: class {
      constructor(config) {
        mockClientConfigs.push(config);
        this.send = mockSend;
      }
    },
    SendMessageCommand: command('Send'),
    ReceiveMessageCommand: command('Receive'),
    DeleteMessageCommand: command('Delete'),
    ChangeMessageVisibilityCommand: command('Visibility'),
  };
});

const QUEUE_URL = 'http://sqs.example/000000000000/jobs';

describe('queue', () => {
  let queue;
  beforeEach(() => {
    jest.resetModules();
    mockSend.mockReset();
    mockClientConfigs.length = 0;
    process.env.AWS_SQS_QUEUE_URL = QUEUE_URL;
    process.env.AWS_REGION = 'us-east-2';
    queue = require('../../src/queue');
  });
  afterEach(() => {
    delete process.env.AWS_SQS_QUEUE_URL;
    delete process.env.AWS_SQS_ENDPOINT_URL;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  });

  test('isEnabled follows AWS_SQS_QUEUE_URL', () => {
    expect(queue.isEnabled()).toBe(true);
    delete process.env.AWS_SQS_QUEUE_URL;
    expect(queue.isEnabled()).toBe(false);
  });

  test('sendJob sends a tiny pointer message with the request id as an attribute', async () => {
    await queue.sendJob({ jobId: 'j1', ownerId: 'o1', requestId: 'r1' });
    const { input } = mockSend.mock.calls[0][0];
    expect(input.QueueUrl).toBe(QUEUE_URL);
    expect(JSON.parse(input.MessageBody)).toEqual({ jobId: 'j1', ownerId: 'o1' });
    expect(input.MessageAttributes).toEqual({
      requestId: { DataType: 'String', StringValue: 'r1' },
    });
  });

  test('sendJob without a request id sends no attributes', async () => {
    await queue.sendJob({ jobId: 'j1', ownerId: 'o1' });
    expect(mockSend.mock.calls[0][0].input).not.toHaveProperty('MessageAttributes');
  });

  test('receive long-polls and maps messages, defaulting the receive count to 1', async () => {
    mockSend.mockResolvedValueOnce({
      Messages: [
        {
          MessageId: 'm1',
          Body: '{"jobId":"j1"}',
          ReceiptHandle: 'rh1',
          Attributes: { ApproximateReceiveCount: '2' },
          MessageAttributes: { requestId: { StringValue: 'r1' } },
        },
        { MessageId: 'm2', Body: '{}', ReceiptHandle: 'rh2' },
      ],
    });

    const messages = await queue.receive({ max: 1, waitSeconds: 20 });
    const { input } = mockSend.mock.calls[0][0];
    expect(input).toMatchObject({
      QueueUrl: QUEUE_URL,
      WaitTimeSeconds: 20,
      MaxNumberOfMessages: 1,
    });
    expect(input.AttributeNames).toEqual(['ApproximateReceiveCount']);
    expect(messages).toEqual([
      { id: 'm1', body: '{"jobId":"j1"}', handle: 'rh1', receiveCount: 2, requestId: 'r1' },
      { id: 'm2', body: '{}', handle: 'rh2', receiveCount: 1, requestId: undefined },
    ]);
  });

  test('receive with nothing waiting resolves to an empty list', async () => {
    mockSend.mockResolvedValueOnce({});
    expect(await queue.receive()).toEqual([]);
  });

  test('remove deletes by receipt handle', async () => {
    await queue.remove('rh1');
    expect(mockSend.mock.calls[0][0]).toMatchObject({
      name: 'Delete',
      input: { QueueUrl: QUEUE_URL, ReceiptHandle: 'rh1' },
    });
  });

  test('delay sets a whole, non-negative visibility timeout', async () => {
    await queue.delay('rh1', 12.6);
    await queue.delay('rh1', -5);
    expect(mockSend.mock.calls[0][0].input.VisibilityTimeout).toBe(13);
    expect(mockSend.mock.calls[1][0].input.VisibilityTimeout).toBe(0);
  });

  test('uses the endpoint and credentials from the environment (MiniStack), once', async () => {
    process.env.AWS_SQS_ENDPOINT_URL = 'http://ministack:4566';
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    await queue.remove('a');
    await queue.remove('b');
    expect(mockClientConfigs).toHaveLength(1);
    expect(mockClientConfigs[0]).toEqual({
      region: 'us-east-2',
      endpoint: 'http://ministack:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'secret' },
    });
  });

  test('in AWS the client is configured with just the region (the task role supplies credentials)', async () => {
    await queue.remove('a');
    expect(mockClientConfigs[0]).toEqual({ region: 'us-east-2' });
  });
});
