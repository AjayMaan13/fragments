// src/routes/api/getId.js

const path = require('path');
const MarkdownIt = require('markdown-it');
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
};

// Get an authenticated user's fragment data by id, optionally converted
// to another supported type via an extension (e.g. ".html")
module.exports = async (req, res) => {
  const ext = path.extname(req.params.id); // '' or e.g. '.html'
  const id = ext ? req.params.id.slice(0, -ext.length) : req.params.id;

  try {
    const fragment = await Fragment.byId(req.user, id);
    const data = await fragment.getData();

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

    // Requested extension matches the fragment's own type: return the raw data
    if (targetType === fragment.mimeType) {
      res.setHeader('Content-Type', fragment.type);
      return res.status(200).send(data);
    }

    // The only real conversion required for Assignment 2: markdown -> HTML
    if (fragment.mimeType === 'text/markdown' && targetType === 'text/html') {
      const html = md.render(data.toString());
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(html);
    }

    // Fallback: any supported type -> text/plain is just the raw bytes as text
    if (targetType === 'text/plain') {
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(data);
    }

    logger.warn({ id, ext, fragmentType: fragment.type }, 'Unsupported conversion requested');
    return res
      .status(415)
      .json(createErrorResponse(415, `Cannot convert ${fragment.type} to ${ext}`));
  } catch (err) {
    logger.warn({ err, id }, 'Fragment not found');
    res.status(404).json(createErrorResponse(404, 'Fragment not found'));
  }
};
