// tests/unit/fragment-model.test.js

// Details of the Fragment model that other tests only brush past: exact
// validation messages, expiry at the boundary, and which formats each type offers.

jest.mock('../../src/model/data/memory', () => {
  const actual = jest.requireActual('../../src/model/data/memory');
  return { ...actual, listFragments: jest.fn(actual.listFragments) };
});

const memory = require('../../src/model/data/memory');
const { Fragment } = require('../../src/model/fragment');

const owner = 'model-test-owner';

describe('constructor validation', () => {
  test.each([
    ['missing owner', { type: 'text/plain' }, 'ownerId is required'],
    ['missing type', { ownerId: owner }, 'type is required'],
    ['unsupported type', { ownerId: owner, type: 'video/mp4' }, 'unsupported type: video/mp4'],
    [
      'non-numeric size',
      { ownerId: owner, type: 'text/plain', size: '5' },
      'size must be a number',
    ],
    ['negative size', { ownerId: owner, type: 'text/plain', size: -1 }, 'size cannot be negative'],
    [
      'non-integer expiry',
      { ownerId: owner, type: 'text/plain', expiresAt: 1.5 },
      'expiresAt must be an integer (Unix time in seconds)',
    ],
  ])('%s is rejected with a clear message', (_name, input, message) => {
    expect(() => new Fragment(input)).toThrow(message);
  });

  test('size 0 is allowed', () => {
    expect(new Fragment({ ownerId: owner, type: 'text/plain', size: 0 }).size).toBe(0);
  });

  test('expiresAt is only a property when one was given', () => {
    expect('expiresAt' in new Fragment({ ownerId: owner, type: 'text/plain' })).toBe(false);
    expect(new Fragment({ ownerId: owner, type: 'text/plain', expiresAt: 100 }).expiresAt).toBe(
      100
    );
    // 0 is a real (long past) time, not "no expiry"
    expect('expiresAt' in new Fragment({ ownerId: owner, type: 'text/plain', expiresAt: 0 })).toBe(
      true
    );
  });
});

describe('isExpired', () => {
  afterEach(() => jest.restoreAllMocks());
  const NOW_SECONDS = 1_700_000_000;
  const at = (expiresAt) => new Fragment({ ownerId: owner, type: 'text/plain', expiresAt });

  test('never expires without an expiry time', () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_SECONDS * 1000);
    expect(at(undefined).isExpired).toBe(false);
  });

  test('is expired exactly at the expiry second, not one second before', () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_SECONDS * 1000);
    expect(at(NOW_SECONDS).isExpired).toBe(true);
    expect(at(NOW_SECONDS - 1).isExpired).toBe(true);
    expect(at(NOW_SECONDS + 1).isExpired).toBe(false);
  });
});

describe('Fragment.byUser', () => {
  afterEach(() => memory.listFragments.mockClear());

  test('accepts plain objects from the database (DynamoDB returns objects, not JSON strings)', async () => {
    memory.listFragments.mockResolvedValueOnce([
      { id: 'a', ownerId: owner, type: 'text/plain', size: 1 },
      { id: 'b', ownerId: owner, type: 'text/markdown', size: 2 },
    ]);
    expect(await Fragment.byUser(owner)).toEqual(['a', 'b']);
  });

  test('also accepts JSON strings (the in-memory store)', async () => {
    memory.listFragments.mockResolvedValueOnce([
      JSON.stringify({ id: 'c', ownerId: owner, type: 'text/plain', size: 1 }),
    ]);
    expect(await Fragment.byUser(owner)).toEqual(['c']);
  });

  test('an empty or missing listing is an empty list', async () => {
    memory.listFragments.mockResolvedValueOnce(undefined);
    expect(await Fragment.byUser(owner)).toEqual([]);
    memory.listFragments.mockResolvedValueOnce(null);
    expect(await Fragment.byUser(owner, true)).toEqual([]);
  });

  test('expired fragments are left out, and expand returns Fragment objects', async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    memory.listFragments.mockResolvedValueOnce([
      { id: 'live', ownerId: owner, type: 'text/plain' },
      { id: 'dead', ownerId: owner, type: 'text/plain', expiresAt: past },
    ]);
    const full = await Fragment.byUser(owner, true);
    expect(full.map((f) => f.id)).toEqual(['live']);
    expect(full[0]).toBeInstanceOf(Fragment);
  });
});

describe('setData', () => {
  test('refuses anything that is not a Buffer', async () => {
    const f = new Fragment({ ownerId: owner, type: 'text/plain' });
    await expect(f.setData('a string')).rejects.toThrow('data must be a Buffer');
    await expect(f.setData(null)).rejects.toThrow('data must be a Buffer');
    await expect(f.setData(undefined)).rejects.toThrow('data must be a Buffer');
  });

  test('records the byte size (not the character count)', async () => {
    const f = new Fragment({ ownerId: owner, type: 'text/plain' });
    await f.setData(Buffer.from('héllo')); // 5 characters, 6 bytes
    expect(f.size).toBe(6);
  });
});

describe('type helpers', () => {
  test('isText is true for text/* only', () => {
    const is = (type) => new Fragment({ ownerId: owner, type }).isText;
    expect(is('text/plain')).toBe(true);
    expect(is('text/markdown; charset=utf-8')).toBe(true);
    expect(is('application/json')).toBe(false);
    expect(is('image/png')).toBe(false);
  });

  test('mimeType drops the parameters', () => {
    expect(new Fragment({ ownerId: owner, type: 'text/plain; charset=utf-8' }).mimeType).toBe(
      'text/plain'
    );
  });

  test('isSupportedType never throws on garbage; it just says no', () => {
    for (const bad of ['not a type', '', undefined, null, 5, '/', 'text/']) {
      expect(Fragment.isSupportedType(bad)).toBe(false);
    }
    expect(Fragment.isSupportedType('text/plain; charset=utf-8')).toBe(true);
  });
});

describe('formats', () => {
  const formats = (type) => new Fragment({ ownerId: owner, type }).formats;

  test('exactly what each type converts to', () => {
    expect(formats('text/plain')).toEqual([
      'text/plain',
      expect.stringContaining('pdf'),
      expect.stringContaining('wordprocessingml'),
    ]);
    expect(formats('text/html')).toEqual(['text/html', 'text/plain']);
    expect(formats('text/csv')).toEqual(['text/csv', 'text/plain', 'application/json']);
    expect(formats('application/yaml')).toEqual(['application/yaml', 'text/plain']);
    expect(formats('application/xml')).toEqual([
      'application/xml',
      'application/json',
      'text/plain',
    ]);
    expect(formats('application/json')).toEqual([
      'application/json',
      'application/yaml',
      'application/xml',
      'text/plain',
    ]);
    expect(formats('text/markdown')).toHaveLength(5);
  });

  test('every image type converts to every image type', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif']) {
      expect(formats(type)).toHaveLength(5);
      expect(formats(type)).toContain('image/png');
      expect(formats(type)).toContain(type);
    }
  });

  test('a type with no entry can only be itself', () => {
    const f = new Fragment({ ownerId: owner, type: 'text/plain' });
    f.type = 'application/x-unknown';
    expect(f.formats).toEqual(['application/x-unknown']);
  });
});
