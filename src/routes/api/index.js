// src/routes/api/index.js

/**
 * The main entry-point for the v1 version of the fragments API.
 */
const express = require('express');
const contentType = require('content-type');
const { Fragment } = require('../../model/fragment');

// Create a router on which to mount our API endpoints
const router = express.Router();

// Raw body parser: gives req.body as a Buffer for supported types, else {}
const rawBody = () =>
  express.raw({
    inflate: true,
    limit: '5mb',
    type: (req) => {
      try {
        const { type } = contentType.parse(req.headers['content-type'] || '');
        return Fragment.isSupportedType(type);
      } catch {
        return false;
      }
    },
  });

router.get('/fragments', require('./get'));
router.get('/fragments/:id/info', require('./getIdInfo'));
router.get('/fragments/:id', require('./getId'));
router.post('/fragments', rawBody(), require('./post'));
router.delete('/fragments/:id', require('./delete'));

module.exports = router;
