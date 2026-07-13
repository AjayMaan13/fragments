// src/model/data/index.js

const logger = require('../../logger');

// If the environment sets an AWS Region, we'll use AWS storage
// services (S3, DynamoDB); otherwise, we'll use an in-memory db.
// Warn the user in case this wasn't intentional.
const { AWS_REGION } = process.env;
if (!AWS_REGION) {
  logger.warn('No AWS_REGION environment variable set. Using MemoryDB vs. AWS storage');
}
module.exports = AWS_REGION ? require('./aws') : require('./memory');
