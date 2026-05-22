// src/auth/index.js

// Make sure our env isn't configured for both AWS Cognito and HTTP Basic Auth.
// We can only do one or the other.  If your .env file contains all 3 of these
// variables, something is wrong.  It should have AWS_COGNITO_POOL_ID and
// AWS_COGNITO_CLIENT_ID together OR HTPASSWD_FILE on its own.
if (
  process.env.AWS_COGNITO_POOL_ID &&
  process.env.AWS_COGNITO_CLIENT_ID &&
  process.env.HTPASSWD_FILE
) {
  throw new Error(
    'env contains configuration for both AWS Cognito and HTTP Basic Auth. Only one is allowed.'
  );
}

// Prefer Amazon Cognito (production)
if (process.env.AWS_COGNITO_POOL_ID && process.env.AWS_COGNITO_CLIENT_ID) {
  module.exports = require('./cognito');
}
// Also allow for an .htpasswd file to be used, but not in production
else if (process.env.HTPASSWD_FILE && process.env.NODE_ENV !== 'production') {
  module.exports = require('./basic-auth');
}
// In all other cases, we need to stop now and fix our config
else {
  throw new Error('missing env vars: no authorization configuration found');
}
