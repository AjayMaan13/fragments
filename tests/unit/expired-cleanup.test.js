// Unit tests for the Lambda that removes an expired fragment's S3 data

jest.mock('@aws-sdk/client-s3');

const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { handler } = require('../../infra/modules/events/lambda');

const record = (ownerId, id) => ({
  eventName: 'REMOVE',
  dynamodb: { Keys: { ownerId: { S: ownerId }, id: { S: id } } },
});

describe('expired fragment cleanup', () => {
  beforeEach(() => {
    process.env.BUCKET_NAME = 'test-bucket';
    DeleteObjectCommand.mockClear();
  });

  test('deletes the S3 object for every expired fragment in the batch', async () => {
    await handler({ Records: [record('owner-a', 'id-1'), record('owner-b', 'id-2')] });

    expect(DeleteObjectCommand).toHaveBeenCalledTimes(2);
    expect(DeleteObjectCommand).toHaveBeenCalledWith({
      Bucket: 'test-bucket',
      Key: 'owner-a/id-1',
    });
    expect(DeleteObjectCommand).toHaveBeenCalledWith({
      Bucket: 'test-bucket',
      Key: 'owner-b/id-2',
    });
    expect(S3Client.mock.instances[0].send).toHaveBeenCalledTimes(2);
  });

  test('fails the invocation when S3 fails, so Lambda retries the batch', async () => {
    S3Client.mock.instances[0].send.mockRejectedValueOnce(new Error('S3 down'));

    await expect(handler({ Records: [record('owner-a', 'id-1')] })).rejects.toThrow('S3 down');
  });
});
