// Unit tests for the in-memory data backend (src/model/data/memory/index.js)

const {
  readFragment,
  writeFragment,
  readFragmentData,
  writeFragmentData,
  listFragments,
  deleteFragment,
} = require('../../src/model/data/memory');

describe('memory data backend', () => {
  test('writeFragment/readFragment round-trips metadata', async () => {
    const frag = { ownerId: 'a', id: '1', type: 'text/plain', size: 0 };
    await writeFragment(frag);
    expect(await readFragment('a', '1')).toEqual(frag);
  });

  test('readFragment returns undefined for missing fragment', async () => {
    expect(await readFragment('a', 'nope')).toBe(undefined);
  });

  test('writeFragmentData/readFragmentData round-trips a Buffer', async () => {
    const buf = Buffer.from('hello');
    await writeFragmentData('a', '2', buf);
    expect(await readFragmentData('a', '2')).toEqual(buf);
  });

  test('readFragmentData returns undefined for missing data', async () => {
    expect(await readFragmentData('a', 'nope')).toBe(undefined);
  });

  test('listFragments returns empty array when user has no fragments', async () => {
    const result = await listFragments('no-such-user');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  test('listFragments returns array of ids by default', async () => {
    const frag = { ownerId: 'b', id: '3', type: 'text/plain', size: 0 };
    await writeFragment(frag);
    const result = await listFragments('b');
    expect(result).toEqual(['3']);
  });

  test('listFragments returns full objects when expand=true', async () => {
    const frag = { ownerId: 'c', id: '4', type: 'text/plain', size: 0 };
    await writeFragment(frag);
    const result = await listFragments('c', true);
    // The memory backend stores serialized JSON strings, so expanded results
    // come back as strings — parse each one to compare against the original object
    expect(result.map((f) => (typeof f === 'string' ? JSON.parse(f) : f))).toEqual([frag]);
  });

  test('deleteFragment removes both metadata and data', async () => {
    const frag = { ownerId: 'd', id: '5', type: 'text/plain', size: 0 };
    await writeFragment(frag);
    await writeFragmentData('d', '5', Buffer.from('some data'));

    await deleteFragment('d', '5');

    expect(await readFragment('d', '5')).toBe(undefined);
    expect(await readFragmentData('d', '5')).toBe(undefined);
  });

  test('writeFragment overwrites existing metadata', async () => {
    const frag = { ownerId: 'e', id: '6', type: 'text/plain', size: 0 };
    await writeFragment(frag);

    const updated = { ...frag, size: 99 };
    await writeFragment(updated);

    expect(await readFragment('e', '6')).toEqual(updated);
  });
});
