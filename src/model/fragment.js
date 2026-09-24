// Use crypto.randomUUID() to create unique IDs, see:
// https://nodejs.org/api/crypto.html#cryptorandomuuidoptions
const { randomUUID } = require('crypto');
// Use https://www.npmjs.com/package/content-type to create/parse Content-Type headers
const contentType = require('content-type');

// Functions for working with fragment metadata/data using our DB
const {
  readFragment,
  writeFragment,
  readFragmentData,
  writeFragmentData,
  listFragments,
  deleteFragment,
  incrementViews,
  createShareUrl,
} = require('./data');
const { PDF, DOCX } = require('../convert');

const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif'];

const supportedTypes = [
  'text/plain',
  'text/markdown',
  'text/html',
  'text/csv',
  'application/json',
  'application/yaml',
  'application/xml',
  ...imageTypes,
];

class Fragment {
  constructor({ id, ownerId, created, updated, type, size = 0, expiresAt, viewCount = 0 }) {
    if (!ownerId) throw new Error('ownerId is required');
    if (!type) throw new Error('type is required');
    if (!Fragment.isSupportedType(type)) throw new Error(`unsupported type: ${type}`);
    if (typeof size !== 'number') throw new Error('size must be a number');
    if (size < 0) throw new Error('size cannot be negative');
    if (expiresAt !== undefined && !Number.isInteger(expiresAt)) {
      throw new Error('expiresAt must be an integer (Unix time in seconds)');
    }

    this.id = id || randomUUID();
    this.ownerId = ownerId;
    this.created = created || new Date().toISOString();
    this.updated = updated || new Date().toISOString();
    this.type = type;
    this.size = size;
    this.viewCount = viewCount;
    // Only set when the fragment expires: the DynamoDB client rejects
    // `undefined` values, and items without this attribute never expire.
    if (expiresAt !== undefined) this.expiresAt = expiresAt;
  }

  /**
   * True once the fragment's expiry time (Unix seconds) has passed. DynamoDB's
   * TTL cleanup can lag by up to a couple of days, so we check on read too.
   * @returns {boolean}
   */
  get isExpired() {
    return this.expiresAt !== undefined && this.expiresAt <= Math.floor(Date.now() / 1000);
  }

  /**
   * Get all fragments (id or full) for the given user
   * @param {string} ownerId user's hashed email
   * @param {boolean} expand whether to expand ids to full fragments
   * @returns Promise<Array<Fragment>>
   */
  static async byUser(ownerId, expand = false) {
    // Always fetch full items: an id-only listing can't tell which ones expired
    const items = (await listFragments(ownerId, true)) || [];
    // listFragments returns plain objects (deserialized JSON); re-create Fragment instances
    const fragments = items
      .map((f) => new Fragment(typeof f === 'string' ? JSON.parse(f) : f))
      .filter((f) => !f.isExpired);
    return expand ? fragments : fragments.map((f) => f.id);
  }

  /**
   * Gets a fragment for the user by the given id.
   * @param {string} ownerId user's hashed email
   * @param {string} id fragment's id
   * @returns Promise<Fragment>
   */
  static async byId(ownerId, id) {
    const data = await readFragment(ownerId, id);
    if (!data) throw new Error(`fragment not found: ${id}`);
    // Re-create a real Fragment instance (readFragment returns a plain object)
    const fragment = new Fragment(data);
    // An expired fragment is treated exactly like a missing one
    if (fragment.isExpired) throw new Error(`fragment not found: ${id}`);
    return fragment;
  }

  /**
   * Delete the user's fragment data and metadata for the given id
   * @param {string} ownerId user's hashed email
   * @param {string} id fragment's id
   * @returns Promise<void>
   */
  static delete(ownerId, id) {
    return deleteFragment(ownerId, id);
  }

  /**
   * Saves the current fragment (metadata) to the database
   * @returns Promise<void>
   */
  save() {
    this.updated = new Date().toISOString();
    return writeFragment(this);
  }

  /**
   * Atomically adds one to the fragment's stored view count
   * @returns Promise<number> the new count
   */
  async recordView() {
    this.viewCount = await incrementViews(this.ownerId, this.id);
    return this.viewCount;
  }

  /**
   * Creates a temporary public link to the fragment's data. The link never
   * outlives the fragment itself: S3 keeps the object after DynamoDB's TTL
   * removes the metadata, so an unbounded link could leak expired data.
   * @param {number} expiresIn requested link lifetime in seconds
   * @returns Promise<{url: string, expiresIn: number, expiresAt: number}|null>
   *   null when the storage backend can't make links (in-memory mode)
   */
  async createShareLink(expiresIn) {
    const now = Math.floor(Date.now() / 1000);
    const remaining = this.expiresAt === undefined ? Infinity : this.expiresAt - now;
    const seconds = Math.max(1, Math.min(expiresIn, remaining));

    // Never serve user-supplied HTML as a live page from the storage domain
    const contentType = this.mimeType === 'text/html' ? 'text/plain' : this.type;

    const url = await createShareUrl(this.ownerId, this.id, seconds, contentType);
    if (!url) return null;
    return { url, expiresIn: seconds, expiresAt: now + seconds };
  }

  /**
   * Gets the fragment's data from the database
   * @returns Promise<Buffer>
   */
  getData() {
    return readFragmentData(this.ownerId, this.id);
  }

  /**
   * Set's the fragment's data in the database
   * @param {Buffer} data
   * @returns Promise<void>
   */
  async setData(data) {
    if (!Buffer.isBuffer(data)) throw new Error('data must be a Buffer');
    this.size = Buffer.byteLength(data);
    this.updated = new Date().toISOString();
    await writeFragment(this); // keep metadata (size/updated) in sync
    return writeFragmentData(this.ownerId, this.id, data);
  }

  /**
   * Returns the mime type (e.g., without encoding) for the fragment's type:
   * "text/html; charset=utf-8" -> "text/html"
   * @returns {string} fragment's mime type (without encoding)
   */
  get mimeType() {
    const { type } = contentType.parse(this.type);
    return type;
  }

  /**
   * Returns true if this fragment is a text/* mime type
   * @returns {boolean} true if fragment's type is text/*
   */
  get isText() {
    return this.mimeType.startsWith('text/');
  }

  /**
   * Returns the formats into which this fragment type can be converted
   * @returns {Array<string>} list of supported mime types
   */
  get formats() {
    const conversionMap = {
      'text/plain': ['text/plain', PDF, DOCX],
      'text/markdown': ['text/markdown', 'text/html', 'text/plain', PDF, DOCX],
      'text/html': ['text/html', 'text/plain'],
      'text/csv': ['text/csv', 'text/plain', 'application/json'],
      'application/json': ['application/json', 'application/yaml', 'application/xml', 'text/plain'],
      'application/yaml': ['application/yaml', 'text/plain'],
      'application/xml': ['application/xml', 'application/json', 'text/plain'],
      'image/png': imageTypes,
      'image/jpeg': imageTypes,
      'image/webp': imageTypes,
      'image/avif': imageTypes,
      'image/gif': imageTypes,
    };
    return conversionMap[this.mimeType] || [this.mimeType];
  }

  /**
   * Returns true if we know how to work with this content type
   * @param {string} value a Content-Type value (e.g., 'text/plain' or 'text/plain: charset=utf-8')
   * @returns {boolean} true if we support this Content-Type (i.e., type/subtype)
   */
  static isSupportedType(value) {
    try {
      const { type } = contentType.parse(value);
      return supportedTypes.includes(type);
    } catch {
      return false;
    }
  }
}

module.exports.Fragment = Fragment;
