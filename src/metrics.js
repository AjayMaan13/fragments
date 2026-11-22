// src/metrics.js

// Custom CloudWatch metrics with no extra infrastructure: we print one
// "Embedded Metric Format" (EMF) JSON line per measurement through pino. The
// ECS awslogs driver ships it to CloudWatch Logs, and CloudWatch turns any line
// with an `_aws` block into a real metric. No PutMetricData call, no IAM change.
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
//
// Keep dimensions few: every distinct dimension value is a separate (billable)
// custom metric. We use only the conversion's target type (a handful of values).
//
// Note: these lines are emitted at `info`, so FRAGMENTS_LOG_LEVEL=warn or higher
// turns the metrics off.

const logger = require('./logger');

const NAMESPACE = 'Fragments';

// Record how long one conversion took, in milliseconds
function recordConversion(targetType, durationMs) {
  logger.info(
    {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: NAMESPACE,
            Dimensions: [['TargetType']],
            Metrics: [{ Name: 'ConversionDuration', Unit: 'Milliseconds' }],
          },
        ],
      },
      TargetType: targetType,
      ConversionDuration: durationMs,
    },
    'conversion'
  );
}

// Run `fn` and record its duration under `targetType`. Failures are not
// recorded (their duration would skew the metric); the caller logs those.
async function timeConversion(targetType, fn) {
  const start = process.hrtime.bigint();
  const result = await fn();
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  recordConversion(targetType, Math.round(durationMs * 100) / 100);
  return result;
}

// Record one finished job: how long the worker spent converting, and how long
// the caller waited in total (queued + converting), both in milliseconds
function recordJob(targetType, processingMs, endToEndMs) {
  logger.info(
    {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: NAMESPACE,
            Dimensions: [['TargetType']],
            Metrics: [
              { Name: 'JobDuration', Unit: 'Milliseconds' },
              { Name: 'JobEndToEnd', Unit: 'Milliseconds' },
            ],
          },
        ],
      },
      TargetType: targetType,
      JobDuration: processingMs,
      JobEndToEnd: endToEndMs,
    },
    'job finished'
  );
}

module.exports = { recordConversion, recordJob, timeConversion, NAMESPACE };
