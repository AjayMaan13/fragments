// src/routes/api/getId.js

const path = require('path');
const MarkdownIt = require('markdown-it');
const yaml = require('js-yaml');
const csvtojson = require('csvtojson');
const sharp = require('sharp');
const { Fragment } = require('../../model/fragment');
const { createErrorResponse } = require('../../response');
const logger = require('../../logger');

const md = new MarkdownIt();

// Map a URL extension to the Content-Type it represents
const extToType = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
};

const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif'];

// Map an image Content-Type to the format name sharp expects
const sharpFormatByType = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
};

const MAX_WIDTH = 4096;

// Convert image bytes to the target type, optionally shrinking to `width`
// pixels wide (aspect ratio kept; never enlarged).
const transformImage = (data, targetType, width) => {
  const pipeline = sharp(data);
  if (width) pipeline.resize({ width, withoutEnlargement: true });
  return pipeline.toFormat(sharpFormatByType[targetType]).toBuffer();
};

// Get an authenticated user's fragment data by id, optionally converted
// to another supported type via an extension (e.g. ".html"). Images can also be
// shrunk with `?width=<pixels>` (e.g. `/v1/fragments/:id.webp?width=200`).
module.exports = async (req, res) => {
  const ext = path.extname(req.params.id); // '' or e.g. '.html'
  const id = ext ? req.params.id.slice(0, -ext.length) : req.params.id;

  let fragment;
  let data;
  try {
    fragment = await Fragment.byId(req.user, id);
    data = await fragment.getData();
  } catch (err) {
    logger.warn({ err, id }, 'Fragment not found');
    return res.status(404).json(createErrorResponse(404, 'Fragment not found'));
  }

  let width;
  if (req.query.width !== undefined) {
    width = Number(req.query.width);
    if (!Number.isInteger(width) || width < 1 || width > MAX_WIDTH) {
      logger.warn({ id, width: req.query.width }, 'Invalid width');
      return res
        .status(400)
        .json(createErrorResponse(400, `width must be a whole number of pixels (1-${MAX_WIDTH})`));
    }
    if (!imageTypes.includes(fragment.mimeType)) {
      logger.warn({ id, fragmentType: fragment.type }, 'width requested for a non-image');
      return res.status(400).json(createErrorResponse(400, 'width only applies to images'));
    }
  }

  // A failed counter update shouldn't stop someone reading their own data
  try {
    await fragment.recordView();
  } catch (err) {
    logger.warn({ err, id }, 'Unable to record fragment view');
  }

  // No extension: return the data using its original type (resized if asked)
  if (!ext) {
    res.setHeader('Content-Type', fragment.type);
    if (!width) return res.status(200).send(data);
    try {
      return res.status(200).send(await transformImage(data, fragment.mimeType, width));
    } catch (err) {
      logger.error({ err, id, width }, 'Error resizing fragment');
      return res.status(500).json(createErrorResponse(500, 'Unable to resize fragment'));
    }
  }

  const targetType = extToType[ext];
  if (!targetType || !fragment.formats.includes(targetType)) {
    logger.warn({ id, ext, fragmentType: fragment.type }, 'Unsupported conversion requested');
    return res
      .status(415)
      .json(createErrorResponse(415, `Cannot convert ${fragment.type} to ${ext}`));
  }

  try {
    // Requested extension matches the fragment's own type: return the raw data
    if (targetType === fragment.mimeType) {
      res.setHeader('Content-Type', fragment.type);
      return res.status(200).send(width ? await transformImage(data, targetType, width) : data);
    }

    // markdown -> html
    if (fragment.mimeType === 'text/markdown' && targetType === 'text/html') {
      const html = md.render(data.toString());
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(html);
    }

    // json -> yaml
    if (fragment.mimeType === 'application/json' && targetType === 'application/yaml') {
      const yamlStr = yaml.dump(JSON.parse(data.toString()));
      res.setHeader('Content-Type', 'application/yaml');
      return res.status(200).send(yamlStr);
    }

    // csv -> json
    if (fragment.mimeType === 'text/csv' && targetType === 'application/json') {
      const rows = await csvtojson().fromString(data.toString());
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send(JSON.stringify(rows));
    }

    // image -> image (any supported pair)
    if (imageTypes.includes(fragment.mimeType) && imageTypes.includes(targetType)) {
      const converted = await transformImage(data, targetType, width);
      res.setHeader('Content-Type', targetType);
      return res.status(200).send(converted);
    }

    // Fallback: any supported text-ish type -> text/plain is just the raw bytes as text
    if (targetType === 'text/plain') {
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(data);
    }

    logger.warn({ id, ext, fragmentType: fragment.type }, 'Unsupported conversion requested');
    return res
      .status(415)
      .json(createErrorResponse(415, `Cannot convert ${fragment.type} to ${ext}`));
  } catch (err) {
    logger.error({ err, id, ext }, 'Error converting fragment');
    return res.status(500).json(createErrorResponse(500, 'Unable to convert fragment'));
  }
};
