// tests/unit/metrics.test.js

// Tests the CloudWatch Embedded Metric Format (EMF) lines src/metrics.js prints.

jest.mock('../../src/logger', () => ({ info: jest.fn() }));

const logger = require('../../src/logger');
const { recordConversion, timeConversion, NAMESPACE } = require('../../src/metrics');

beforeEach(() => logger.info.mockClear());

describe('recordConversion()', () => {
  test('emits a valid EMF line with one dimension (the target type)', () => {
    recordConversion('application/pdf', 12.5);

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [line] = logger.info.mock.calls[0];
    expect(line.TargetType).toBe('application/pdf');
    expect(line.ConversionDuration).toBe(12.5);

    // EMF: the directive names the metric, its unit and which fields are dimensions
    expect(typeof line._aws.Timestamp).toBe('number');
    expect(line._aws.CloudWatchMetrics).toEqual([
      {
        Namespace: NAMESPACE,
        Dimensions: [['TargetType']],
        Metrics: [{ Name: 'ConversionDuration', Unit: 'Milliseconds' }],
      },
    ]);
  });

  test('every metric and dimension named in the directive exists as a field', () => {
    recordConversion('image/avif', 3);
    const [line] = logger.info.mock.calls[0];
    const directive = line._aws.CloudWatchMetrics[0];
    for (const { Name } of directive.Metrics) expect(line).toHaveProperty(Name);
    for (const dim of directive.Dimensions.flat()) expect(line).toHaveProperty(dim);
  });
});

describe('timeConversion()', () => {
  test('returns the result and records the elapsed time under the target type', async () => {
    const result = await timeConversion('text/html', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'done';
    });

    expect(result).toBe('done');
    const [line] = logger.info.mock.calls[0];
    expect(line.TargetType).toBe('text/html');
    expect(line.ConversionDuration).toBeGreaterThanOrEqual(15);
    expect(line.ConversionDuration).toBeLessThan(1000);
  });

  test('records nothing when the conversion throws, and rethrows', async () => {
    await expect(
      timeConversion('text/html', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(logger.info).not.toHaveBeenCalled();
  });
});
