// src/routes/api/getId.js

const path = require('path');
const { Fragment } = require('../../model/fragment');
const { createErrorResponse } = require('../../response');
const logger = require('../../logger');
const { convertFragment, extToType, imageTypes } = require('../../convert');
const { timeConversion } = require('../../metrics');

const MAX_WIDTH = 4096;

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
      const resized = await timeConversion(fragment.mimeType, () =>
        convertFragment(data, fragment.mimeType, fragment.mimeType, { width })
      );
      return res.status(200).send(resized);
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
    const convertIt = () => convertFragment(data, fragment.mimeType, targetType, { width });
    // Only time real work: handing back the same bytes unchanged isn't a conversion
    const doesWork = targetType !== fragment.mimeType || Boolean(width);
    const converted = doesWork ? await timeConversion(targetType, convertIt) : await convertIt();
    if (converted !== undefined) {
      // Same type as the fragment: keep its full Content-Type (charset and all)
      res.setHeader('Content-Type', targetType === fragment.mimeType ? fragment.type : targetType);
      return res.status(200).send(converted);
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
