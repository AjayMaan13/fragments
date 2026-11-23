// tests/unit/search-core.test.js

// The search pieces without HTTP: chunking, vector maths, and the index/search
// service on the in-memory store with the deterministic fake embedder.

process.env.EMBEDDER = 'fake';
process.env.SEARCH_ENABLED = '1';

const { chunk, stripHtml, textOf, isIndexable } = require('../../src/search/chunker');
const { toBuffer, fromBuffer, dot, normalize, topK } = require('../../src/search/vectors');
const { fakeEmbed, setEmbedder, dimensions } = require('../../src/search/embedder');
const { indexFragment, search, removeFromIndex } = require('../../src/search');
const { listChunks } = require('../../src/model/data');
const { Fragment } = require('../../src/model/fragment');

describe('chunk', () => {
  test('short text is one chunk; empty text is none', () => {
    expect(chunk('hello world')).toEqual(['hello world']);
    expect(chunk('')).toEqual([]);
    expect(chunk('   \n\t ')).toEqual([]);
  });

  test('whitespace is collapsed', () => {
    expect(chunk('a   b\n\nc')).toEqual(['a b c']);
  });

  test('long text is split into pieces no longer than the size, cut at spaces', () => {
    const text = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunk(text, { size: 200, overlap: 30 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(200);
      expect(c).toBe(c.trim());
      expect(c.length).toBeGreaterThan(0);
    }
    // a cut never lands inside a word: every chunk ends on a whole "wordN"
    for (const c of chunks) expect(c).toMatch(/word\d+$/);
  });

  test('neighbouring chunks overlap, so a sentence on a boundary is in both', () => {
    const text = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
    const [first, second] = chunk(text, { size: 200, overlap: 50 });
    const tail = first.split(' ').slice(-3).join(' ');
    expect(second).toContain(tail.split(' ')[0]);
  });

  test('every word of the document is in some chunk', () => {
    const words = Array.from({ length: 400 }, (_, i) => `t${i}`);
    const joined = chunk(words.join(' '), { size: 150, overlap: 20 }).join(' ');
    for (const w of words) expect(joined).toContain(`${w} `.trim());
  });

  test('a text with no spaces still splits (hard cut) and always terminates', () => {
    const chunks = chunk('x'.repeat(2500), { size: 900, overlap: 100 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].length).toBe(900);
  });

  test('at most `max` chunks', () => {
    expect(chunk('word '.repeat(5000), { size: 100, overlap: 10, max: 7 })).toHaveLength(7);
  });

  test('text exactly the size is one chunk, one over is two', () => {
    expect(chunk('a'.repeat(900), { size: 900 })).toHaveLength(1);
    expect(chunk(`${'a'.repeat(450)} ${'b'.repeat(450)}`, { size: 900 })).toHaveLength(2);
  });
});

describe('text extraction', () => {
  test('HTML loses its tags, scripts, styles and entities', () => {
    const html =
      '<style>p{color:red}</style><p>Fish &amp; chips</p><script>alert(1)</script><b>now</b>';
    expect(stripHtml(html)).toBe('Fish & chips now');
  });

  test('textOf only strips HTML, leaves markdown and plain text alone', () => {
    expect(textOf(Buffer.from('<h1>Hi</h1>'), 'text/html')).toBe('Hi');
    expect(textOf(Buffer.from('# Hi <3'), 'text/markdown')).toBe('# Hi <3');
    expect(textOf(Buffer.from('a   b'), 'text/plain')).toBe('a b');
  });

  test('only text types are indexable', () => {
    expect(['text/plain', 'text/markdown', 'text/html'].every(isIndexable)).toBe(true);
    expect(['image/png', 'application/json', 'text/csv'].some(isIndexable)).toBe(false);
  });
});

describe('vectors', () => {
  test('a vector survives storage as bytes, including from an unaligned view', () => {
    const v = Float32Array.from([0.5, -1.25, 3]);
    expect([...fromBuffer(toBuffer(v))]).toEqual([0.5, -1.25, 3]);
    const padded = Buffer.concat([Buffer.from([9]), toBuffer(v)]).subarray(1); // starts at an odd offset
    expect([...fromBuffer(padded)]).toEqual([0.5, -1.25, 3]);
  });

  test('normalize gives length 1, and leaves a zero vector alone', () => {
    expect(dot(normalize([3, 4]), normalize([3, 4]))).toBeCloseTo(1);
    expect([...normalize([0, 0])]).toEqual([0, 0]);
  });

  test('dot product of normalised vectors is cosine similarity', () => {
    expect(dot(normalize([1, 0]), normalize([0, 1]))).toBeCloseTo(0);
    expect(dot(normalize([1, 1]), normalize([2, 2]))).toBeCloseTo(1);
    expect(dot(normalize([1, 0]), normalize([-1, 0]))).toBeCloseTo(-1);
  });

  test('topK: best first, at most k, ties broken by id', () => {
    const items = [
      { id: 'b', score: 0.5 },
      { id: 'a', score: 0.5 },
      { id: 'c', score: 0.9 },
      { id: 'd', score: 0.1 },
    ];
    expect(topK(items, 3).map((i) => i.id)).toEqual(['c', 'a', 'b']);
    expect(topK(items, 10)).toHaveLength(4);
    expect(items[0].id).toBe('b'); // input not reordered
  });
});

describe('the fake embedder', () => {
  test('is deterministic, normalised, and the configured size', async () => {
    const a = await fakeEmbed('The quick brown fox');
    const b = await fakeEmbed('the QUICK brown fox');
    expect(a).toHaveLength(256);
    expect(dimensions()).toBe(256);
    expect(dot(a, a)).toBeCloseTo(1);
    expect([...a]).toEqual([...b]);
  });

  test('texts that share words are closer than texts that do not', async () => {
    const [q, near, far] = await Promise.all([
      fakeEmbed('tomato pasta dinner'),
      fakeEmbed('pasta with tomato sauce for dinner'),
      fakeEmbed('linux kernel scheduler'),
    ]);
    expect(dot(q, near)).toBeGreaterThan(dot(q, far) + 0.3);
  });

  test('text with no words gives the zero vector, not NaN', async () => {
    const v = await fakeEmbed('!!! ???');
    expect([...v].every((x) => x === 0)).toBe(true);
  });

  test('EMBEDDING_DIMENSIONS changes the size', async () => {
    process.env.EMBEDDING_DIMENSIONS = '64';
    expect(await fakeEmbed('x')).toHaveLength(64);
    delete process.env.EMBEDDING_DIMENSIONS;
  });
});

describe('indexing and searching', () => {
  let n = 0;
  const owner = () => `search-owner-${++n}`;
  const add = async (ownerId, text, type = 'text/plain', extra = {}) => {
    const f = new Fragment({ ownerId, type, ...extra });
    await f.save();
    await f.setData(Buffer.from(text));
    return f;
  };
  const index = (f, updated) => indexFragment(f.ownerId, f.id, updated ?? f.updated);

  test('finds the fragment about the topic, best match first, with a snippet', async () => {
    const o = owner();
    const pasta = await add(o, 'Cooking pasta with tomato and basil makes a quick dinner recipe');
    const kernel = await add(o, 'The linux kernel scheduler decides which process runs next');
    const garden = await add(o, 'Watering roses and improving garden soil in spring');
    for (const f of [pasta, kernel, garden]) expect(await index(f)).toBe('indexed');

    const results = await search(o, 'quick tomato pasta dinner', 3);
    expect(results.map((r) => r.id)).toEqual([pasta.id, expect.any(String), expect.any(String)]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[0].snippet).toContain('tomato');
    expect(results[0]).toMatchObject({ type: 'text/plain', size: pasta.size });
  });

  test("one user can never find another user's fragments", async () => {
    const alice = owner();
    const bob = owner();
    await index(await add(alice, 'secret plans about the merger with acme'));
    await index(await add(bob, 'weekend hiking trip with friends'));

    expect(
      await search(bob, 'secret merger acme plans', 5).then((r) => r.map((x) => x.snippet))
    ).not.toContain('secret plans about the merger with acme');
    for (const r of await search(bob, 'secret merger acme plans', 5)) {
      expect(r.snippet).not.toContain('acme');
    }
    expect((await listChunks(bob)).every((c) => c.ownerId === bob)).toBe(true);
    expect(await search(owner(), 'anything at all', 5)).toEqual([]);
  });

  test('respects k and returns each fragment once even if several of its chunks match', async () => {
    const o = owner();
    const long = await add(o, `${'tomato pasta '.repeat(150)}`); // several chunks, all matching
    await add(o, 'tomato soup'); // not indexed
    await index(long);
    expect((await listChunks(o)).length).toBeGreaterThan(1);

    const results = await search(o, 'tomato pasta', 5);
    expect(results).toHaveLength(1);
    expect(await search(o, 'tomato pasta', 1)).toHaveLength(1);
  });

  test('a long document is found by the part that matches, not just its start', async () => {
    const o = owner();
    const filler = 'general notes about nothing in particular '.repeat(60);
    const doc = await add(o, `${filler} the submarine propeller cavitation experiment ${filler}`);
    await index(doc);
    const [hit] = await search(o, 'submarine propeller cavitation', 1);
    expect(hit.id).toBe(doc.id);
    expect(hit.snippet).toContain('submarine propeller');
  });

  test('updating re-indexes: the old text stops matching, the new text matches', async () => {
    const o = owner();
    const f = await add(o, 'original text about volcanoes and lava flows');
    await index(f);
    expect((await search(o, 'volcanoes lava', 1))[0].id).toBe(f.id);
    const before = (await listChunks(o)).length;

    await f.setData(Buffer.from('completely different words regarding submarine cables'));
    await index(f);
    expect((await listChunks(o)).length).toBe(before);
    const [hit] = await search(o, 'submarine cables', 1);
    expect(hit.snippet).toContain('submarine');
    expect(
      (await search(o, 'volcanoes lava', 5)).every((r) => !r.snippet.includes('volcanoes'))
    ).toBe(true);
  });

  test('a message for an out-of-date version is skipped', async () => {
    const o = owner();
    const f = await add(o, 'some text');
    expect(await indexFragment(o, f.id, '2000-01-01T00:00:00.000Z')).toBe('stale');
    expect(await listChunks(o)).toEqual([]);
  });

  test('a deleted fragment is "gone" and its chunks are cleaned up', async () => {
    const o = owner();
    const f = await add(o, 'ephemeral note about comets');
    await index(f);
    expect(await listChunks(o)).toHaveLength(1);
    await Fragment.delete(o, f.id);
    expect(await indexFragment(o, f.id, f.updated)).toBe('gone');
    expect(await listChunks(o)).toEqual([]);
  });

  test('non-text fragments are not indexed', async () => {
    const o = owner();
    const f = await add(o, 'not really an image', 'image/png');
    expect(await index(f)).toBe('skipped');
    expect(await listChunks(o)).toEqual([]);
  });

  test('HTML is indexed as the text a reader sees, not its tags', async () => {
    const o = owner();
    await index(
      await add(o, '<html><body><p>Quarterly report about glaciers</p></body></html>', 'text/html')
    );
    const [chunkItem] = await listChunks(o);
    expect(chunkItem.text).toBe('Quarterly report about glaciers');
  });

  test('an empty document has nothing to index and nothing to find', async () => {
    const o = owner();
    expect(await index(await add(o, '   '))).toBe('indexed');
    expect(await listChunks(o)).toEqual([]);
  });

  test('expired fragments disappear from results', async () => {
    const o = owner();
    const soon = Math.floor(Date.now() / 1000) + 100;
    const f = await add(o, 'short lived note on meteors', 'text/plain', { expiresAt: soon });
    await index(f);
    expect(await search(o, 'meteors', 5)).toHaveLength(1);
    expect((await listChunks(o))[0].expiresAt).toBe(soon);

    jest.spyOn(Date, 'now').mockReturnValue((soon + 5) * 1000);
    expect(await search(o, 'meteors', 5)).toEqual([]);
    jest.restoreAllMocks();
  });

  test('a fragment deleted after indexing is skipped and does not shrink the results', async () => {
    const o = owner();
    const keep = [];
    const gone = await add(o, 'zebra stripes zebra stripes zebra');
    for (const t of ['zebra herd', 'zebra crossing', 'zebra foal']) keep.push(await add(o, t));
    for (const f of [gone, ...keep]) await index(f);
    await Fragment.delete(o, gone.id); // chunks left behind on purpose

    const results = await search(o, 'zebra stripes', 3);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.id)).not.toContain(gone.id);
  });

  test("removeFromIndex drops a fragment's chunks", async () => {
    const o = owner();
    const f = await add(o, 'note to forget');
    await index(f);
    await removeFromIndex(o, f.id);
    expect(await listChunks(o)).toEqual([]);
  });

  test('the embedder can be swapped (this is how the real one is injected)', async () => {
    const o = owner();
    const seen = [];
    setEmbedder(async (text) => {
      seen.push(text);
      return normalize(new Float32Array(256).fill(1));
    });
    await index(await add(o, 'whatever'));
    setEmbedder(undefined);
    expect(seen).toEqual(['whatever']);
  });
});
