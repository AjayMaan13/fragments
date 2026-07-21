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

// Get an authenticated user's fragment data by id, optionally converted
// to another supported type via an extension (e.g. ".html")
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

  // No extension: return the raw data using its original type
  if (!ext) {
    res.setHeader('Content-Type', fragment.type);
    return res.status(200).send(data);
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
      return res.status(200).send(data);
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
      const converted = await sharp(data).toFormat(sharpFormatByType[targetType]).toBuffer();
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
