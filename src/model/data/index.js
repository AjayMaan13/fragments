// src/model/data/index.js
// Pick the data backend. For now we only have the in-memory one.
// We'll add AWS DynamoDB/S3 backends in later assignments.
module.exports = require('./memory');
