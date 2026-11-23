// src/model/data/aws/index.js

const logger = require('../../../logger');
const s3Client = require('./s3Client');
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const ddbDocClient = require('./ddbDocClient');
const {
  BatchWriteCommand,
  PutCommand,
  GetCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

// Writes a fragment to DynamoDB. Returns a Promise.
function writeFragment(fragment) {
  // Configure our PUT params, with the name of the table and item (attributes and keys)
  const params = {
    TableName: process.env.AWS_DYNAMODB_TABLE_NAME,
    Item: fragment,
  };

  // Create a PUT command to send to DynamoDB
  const command = new PutCommand(params);

  try {
    return ddbDocClient.send(command);
  } catch (err) {
    logger.warn({ err, params, fragment }, 'error writing fragment to DynamoDB');
    throw err;
  }
}

// Reads a fragment from DynamoDB. Returns a Promise<fragment|undefined>
async function readFragment(ownerId, id) {
  // Configure our GET params, with the name of the table and key (partition key + sort key)
  const params = {
    TableName: process.env.AWS_DYNAMODB_TABLE_NAME,
    Key: { ownerId, id },
  };

  // Create a GET command to send to DynamoDB
  const command = new GetCommand(params);

  try {
    // Wait for the data to come back from AWS
    const data = await ddbDocClient.send(command);
    // We may or may not get back any data (e.g., no item found for the given key).
    // If we get back an item (fragment), we'll return it.  Otherwise we'll return `undefined`.
    return data?.Item;
  } catch (err) {
    logger.warn({ err, params }, 'error reading fragment from DynamoDB');
    throw err;
  }
}

// Writes a fragment's data to an S3 Object in a Bucket
// https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/s3-example-creating-buckets.md#upload-an-existing-object-to-an-amazon-s3-bucket
async function writeFragmentData(ownerId, id, data) {
  // Create the PUT API params from our details
  const params = {
    Bucket: process.env.AWS_S3_BUCKET_NAME,
    // Our key will be a mix of the ownerID and fragment id, written as a path
    Key: `${ownerId}/${id}`,
    Body: data,
  };

  // Create a PUT Object command to send to S3
  const command = new PutObjectCommand(params);

  try {
    // Use our client to send the command
    await s3Client.send(command);
  } catch (err) {
    // If anything goes wrong, log enough info that we can debug
    const { Bucket, Key } = params;
    logger.error({ err, Bucket, Key }, 'Error uploading fragment data to S3');
    throw new Error('unable to upload fragment data', { cause: err });
  }
}

// Convert a stream of data into a Buffer, by collecting
// chunks of data until finished, then assembling them together.
// We wrap the whole thing in a Promise so it's easier to consume.
const streamToBuffer = (stream) =>
  new Promise((resolve, reject) => {
    // As the data streams in, we'll collect it into an array.
    const chunks = [];

    // Streams have events that we can listen for and run
    // code.  We need to know when new `data` is available,
    // if there's an `error`, and when we're at the `end`
    // of the stream.

    // When there's data, add the chunk to our chunks list
    stream.on('data', (chunk) => chunks.push(chunk));
    // When there's an error, reject the Promise
    stream.on('error', reject);
    // When the stream is done, resolve with a new Buffer of our chunks
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });

// Reads a fragment's data from S3 and returns (Promise<Buffer>)
// https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/s3-example-creating-buckets.md#getting-a-file-from-an-amazon-s3-bucket
async function readFragmentData(ownerId, id) {
  // Create the GET API params from our details
  const params = {
    Bucket: process.env.AWS_S3_BUCKET_NAME,
    // Our key will be a mix of the ownerID and fragment id, written as a path
    Key: `${ownerId}/${id}`,
  };

  // Create a GET Object command to send to S3
  const command = new GetObjectCommand(params);

  try {
    // Get the object from the Amazon S3 bucket. It is returned as a ReadableStream.
    const data = await s3Client.send(command);
    // Convert the ReadableStream to a Buffer
    return streamToBuffer(data.Body);
  } catch (err) {
    const { Bucket, Key } = params;
    logger.error({ err, Bucket, Key }, 'Error streaming fragment data from S3');
    throw new Error('unable to read fragment data', { cause: err });
  }
}

// Get a list of fragments, either ids-only, or full Objects, for the given user.
// Returns a Promise<Array<Fragment>|Array<string>|undefined>
async function listFragments(ownerId, expand = false) {
  // Configure our QUERY params, with the name of the table and the query expression
  const params = {
    TableName: process.env.AWS_DYNAMODB_TABLE_NAME,
    // Specify that we want to get all items where the ownerId is equal to the
    // `:ownerId` that we'll define below in the ExpressionAttributeValues.
    KeyConditionExpression: 'ownerId = :ownerId',
    // Use the `ownerId` value to do the query
    ExpressionAttributeValues: {
      ':ownerId': ownerId,
    },
  };

  // Limit to only `id` if we aren't supposed to expand. Without doing this
  // we'll get back every attribute.  The projection expression defines a list
  // of attributes to return, see:
  // https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ProjectionExpressions.html
  if (!expand) {
    params.ProjectionExpression = 'id';
  }

  // Create a QUERY command to send to DynamoDB
  const command = new QueryCommand(params);

  try {
    // Wait for the data to come back from AWS
    const data = await ddbDocClient.send(command);

    // If we haven't expanded to include all attributes, remap this array from
    // [ {"id":"b9e7a264-630f-436d-a785-27f30233faea"}, {"id":"dad25b07-8cd6-498b-9aaf-46d358ea97fe"} ,... ] to
    // [ "b9e7a264-630f-436d-a785-27f30233faea", "dad25b07-8cd6-498b-9aaf-46d358ea97fe", ... ]
    return !expand ? data?.Items.map((item) => item.id) : data?.Items;
  } catch (err) {
    logger.error({ err, params }, 'error getting all fragments for user from DynamoDB');
    throw err;
  }
}

// Deletes a fragment's data from an S3 Object in a Bucket
async function deleteFragmentData(ownerId, id) {
  const params = {
    Bucket: process.env.AWS_S3_BUCKET_NAME,
    Key: `${ownerId}/${id}`,
  };

  const command = new DeleteObjectCommand(params);

  try {
    await s3Client.send(command);
  } catch (err) {
    const { Bucket, Key } = params;
    logger.error({ err, Bucket, Key }, 'Error deleting fragment data from S3');
    throw new Error('unable to delete fragment data', { cause: err });
  }
}

// Deletes a fragment's metadata (item) from DynamoDB
function deleteFragmentMetadata(ownerId, id) {
  const params = {
    TableName: process.env.AWS_DYNAMODB_TABLE_NAME,
    Key: { ownerId, id },
  };

  const command = new DeleteCommand(params);

  try {
    return ddbDocClient.send(command);
  } catch (err) {
    logger.warn({ err, params }, 'error deleting fragment metadata from DynamoDB');
    throw err;
  }
}

// Delete a fragment's metadata (DynamoDB) and data (S3). Returns a Promise
function deleteFragment(ownerId, id) {
  return Promise.all([
    // Delete metadata
    deleteFragmentMetadata(ownerId, id),
    // Delete data
    deleteFragmentData(ownerId, id),
  ]);
}

// Atomically adds one to a fragment's `viewCount` in DynamoDB. ADD is done by
// the database itself, so concurrent requests can't overwrite each other's
// increments. The condition stops it from creating an item for an unknown id.
// Returns a Promise<number> with the new count.
async function incrementViews(ownerId, id) {
  const params = {
    TableName: process.env.AWS_DYNAMODB_TABLE_NAME,
    Key: { ownerId, id },
    UpdateExpression: 'ADD viewCount :one',
    ConditionExpression: 'attribute_exists(id)',
    ExpressionAttributeValues: { ':one': 1 },
    ReturnValues: 'UPDATED_NEW',
  };

  try {
    const data = await ddbDocClient.send(new UpdateCommand(params));
    return data.Attributes.viewCount;
  } catch (err) {
    logger.warn({ err, params }, 'error incrementing fragment views in DynamoDB');
    throw err;
  }
}

// Creates a pre-signed URL that lets anyone with the link download a fragment's
// data straight from S3, until `expiresIn` seconds pass. Signing happens
// locally with our own credentials (no request to AWS). We don't set a
// Content-Type when uploading, so ResponseContentType tells S3 what to send.
// Returns a Promise<string>.
function createShareUrl(ownerId, id, expiresIn, contentType) {
  const command = new GetObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET_NAME,
    Key: `${ownerId}/${id}`,
    ResponseContentType: contentType,
  });
  return getSignedUrl(s3Client, command, { expiresIn });
}

// ---------------------------------------------------------------------------
// Async conversion jobs. They live in their OWN table (not the fragments
// table): that table is listed by owner and every item is turned into a
// Fragment, which would choke on job records.
// ---------------------------------------------------------------------------

const jobsTable = () => process.env.AWS_DYNAMODB_JOBS_TABLE_NAME;
const resultKey = (ownerId, jobId) => `results/${ownerId}/${jobId}`;
const isConditionFailure = (err) => err?.name === 'ConditionalCheckFailedException';

// Creates a job record; fails if the id already exists
function createJob(job) {
  return ddbDocClient.send(
    new PutCommand({
      TableName: jobsTable(),
      Item: job,
      ConditionExpression: 'attribute_not_exists(jobId)',
    })
  );
}

// Reads a job. Returns a Promise<job|undefined>
async function readJob(ownerId, jobId) {
  const data = await ddbDocClient.send(
    new GetCommand({ TableName: jobsTable(), Key: { ownerId, jobId } })
  );
  return data?.Item;
}

function deleteJob(ownerId, jobId) {
  return ddbDocClient.send(new DeleteCommand({ TableName: jobsTable(), Key: { ownerId, jobId } }));
}

// Atomically takes a job for processing: queued -> running, or running whose
// lease has run out (the worker holding it died). Sets a new lease and counts
// the attempt. The database does the check-and-set, so two workers can never
// both claim it. Returns the updated job, or null when it can't be claimed
// (finished, or another worker still holds a live lease).
async function claimJob(ownerId, jobId, nowSeconds, leaseSeconds) {
  try {
    const data = await ddbDocClient.send(
      new UpdateCommand({
        TableName: jobsTable(),
        Key: { ownerId, jobId },
        UpdateExpression:
          'SET #status = :running, #attempts = if_not_exists(#attempts, :zero) + :one, #lease = :lease, #updated = :updated',
        ConditionExpression:
          'attribute_exists(#jobId) AND (#status = :queued OR (#status = :running AND #lease < :now))',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#attempts': 'attempts',
          '#lease': 'leaseUntil',
          '#updated': 'updatedAt',
          '#jobId': 'jobId',
        },
        ExpressionAttributeValues: {
          ':running': 'running',
          ':queued': 'queued',
          ':zero': 0,
          ':one': 1,
          ':lease': nowSeconds + leaseSeconds,
          ':now': nowSeconds,
          ':updated': new Date(nowSeconds * 1000).toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    return data.Attributes;
  } catch (err) {
    if (isConditionFailure(err)) return null;
    throw err;
  }
}

// Moves a job we hold (status running, this attempt number) to a new state and
// sets `fields`. Returns false when we no longer hold it (another worker took
// over after our lease expired), so a slow worker can't overwrite the new one.
async function transitionJob(ownerId, jobId, attempt, status, fields) {
  const names = { '#status': 'status', '#attempts': 'attempts', '#updated': 'updatedAt' };
  const values = {
    ':running': 'running',
    ':attempt': attempt,
    ':status': status,
    ':updated': new Date().toISOString(),
  };
  const sets = ['#status = :status', '#updated = :updated'];
  Object.entries(fields).forEach(([key, value], i) => {
    names[`#f${i}`] = key;
    values[`:f${i}`] = value;
    sets.push(`#f${i} = :f${i}`);
  });

  try {
    await ddbDocClient.send(
      new UpdateCommand({
        TableName: jobsTable(),
        Key: { ownerId, jobId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: '#status = :running AND #attempts = :attempt',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

const finishJob = (ownerId, jobId, attempt, fields) =>
  transitionJob(ownerId, jobId, attempt, 'succeeded', fields);
const failJob = (ownerId, jobId, attempt, error) =>
  transitionJob(ownerId, jobId, attempt, 'failed', { error });
// Back to queued with the lease cleared, so the redelivered message can claim it again
const releaseJob = (ownerId, jobId, attempt, error) =>
  transitionJob(ownerId, jobId, attempt, 'queued', { leaseUntil: 0, lastError: error });

// Conversion results live in the fragments bucket under results/, which has an
// S3 lifecycle rule (infra) so they are deleted after a day.
async function writeJobResult(ownerId, jobId, buffer, contentType) {
  const params = {
    Bucket: process.env.AWS_S3_BUCKET_NAME,
    Key: resultKey(ownerId, jobId),
    Body: buffer,
    ContentType: contentType,
  };
  try {
    await s3Client.send(new PutObjectCommand(params));
  } catch (err) {
    logger.error({ err, Key: params.Key }, 'Error uploading job result to S3');
    throw new Error('unable to upload job result', { cause: err });
  }
}

// A temporary link to download a job's result. Returns a Promise<string>.
function createJobResultUrl(ownerId, jobId, expiresIn, contentType) {
  const command = new GetObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET_NAME,
    Key: resultKey(ownerId, jobId),
    ResponseContentType: contentType,
  });
  return getSignedUrl(s3Client, command, { expiresIn });
}

// ---------------------------------------------------------------------------
// Search index: one item per chunk of a fragment, in their own table (a
// vector per chunk would bloat the fragments table, which is listed by owner).
// ---------------------------------------------------------------------------

const embeddingsTable = () => process.env.AWS_DYNAMODB_EMBEDDINGS_TABLE_NAME;

// All of an owner's chunks (paged)
async function listChunks(ownerId) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddbDocClient.send(
      new QueryCommand({
        TableName: embeddingsTable(),
        KeyConditionExpression: 'ownerId = :o',
        ExpressionAttributeValues: { ':o': ownerId },
        ExclusiveStartKey,
      })
    );
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// BatchWrite takes at most 25 requests and may hand some back unprocessed
async function batchWrite(requests) {
  for (let i = 0; i < requests.length; i += 25) {
    let pending = requests.slice(i, i + 25);
    for (let attempt = 0; pending.length && attempt < 5; attempt++) {
      const out = await ddbDocClient.send(
        new BatchWriteCommand({ RequestItems: { [embeddingsTable()]: pending } })
      );
      pending = out.UnprocessedItems?.[embeddingsTable()] || [];
    }
    if (pending.length) throw new Error('unable to write all chunks');
  }
}

// Remove every chunk of one fragment
async function deleteChunks(ownerId, fragmentId) {
  const keys = [];
  let ExclusiveStartKey;
  do {
    const page = await ddbDocClient.send(
      new QueryCommand({
        TableName: embeddingsTable(),
        KeyConditionExpression: 'ownerId = :o AND begins_with(chunkId, :f)',
        ExpressionAttributeValues: { ':o': ownerId, ':f': `${fragmentId}#` },
        ProjectionExpression: 'ownerId, chunkId',
        ExclusiveStartKey,
      })
    );
    keys.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  await batchWrite(keys.map((Key) => ({ DeleteRequest: { Key } })));
}

// Replace a fragment's chunks: [{ index, text, vector: Buffer }]
async function replaceChunks(ownerId, fragmentId, chunks, { updated, expiresAt } = {}) {
  await deleteChunks(ownerId, fragmentId);
  await batchWrite(
    chunks.map((c) => ({
      PutRequest: {
        Item: {
          ownerId,
          chunkId: `${fragmentId}#${String(c.index).padStart(3, '0')}`,
          fragmentId,
          index: c.index,
          text: c.text,
          vector: c.vector,
          updated,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        },
      },
    }))
  );
}

module.exports.listChunks = listChunks;
module.exports.deleteChunks = deleteChunks;
module.exports.replaceChunks = replaceChunks;
module.exports.createJob = createJob;
module.exports.readJob = readJob;
module.exports.deleteJob = deleteJob;
module.exports.claimJob = claimJob;
module.exports.finishJob = finishJob;
module.exports.failJob = failJob;
module.exports.releaseJob = releaseJob;
module.exports.writeJobResult = writeJobResult;
module.exports.createJobResultUrl = createJobResultUrl;
module.exports.createShareUrl = createShareUrl;
module.exports.incrementViews = incrementViews;
module.exports.listFragments = listFragments;
module.exports.writeFragment = writeFragment;
module.exports.readFragment = readFragment;
module.exports.writeFragmentData = writeFragmentData;
module.exports.readFragmentData = readFragmentData;
module.exports.deleteFragment = deleteFragment;
