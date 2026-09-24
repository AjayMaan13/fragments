// Runs when DynamoDB's TTL deletes an expired fragment record: removes the
// fragment's data from S3, which TTL itself doesn't touch.

const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({});

exports.handler = async (event) => {
  await Promise.all(
    event.Records.map(({ dynamodb: { Keys } }) =>
      s3.send(
        new DeleteObjectCommand({
          Bucket: process.env.BUCKET_NAME,
          // Same key the app uses when it writes the data
          Key: `${Keys.ownerId.S}/${Keys.id.S}`,
        })
      )
    )
  );
};
