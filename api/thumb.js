// GET /api/thumb?id=DRIVE_FILE_ID
//
// Serves thumbnails for any Drive PDF regardless of whether Drive has
// generated one natively. Three-path strategy:
//
//   1. thumbnailLink from Drive API  → proxy the lh3 CDN URL (fast, ~100ms)
//   2. Download PDF + render page 1  → pdfjs-dist + canvas (slow first hit, cached forever)
//   3. Placeholder SVG               → when file is too large or rendering fails
//
// Files uploaded via API are never opened in Drive viewer, so their
// thumbnailLink is permanently empty until someone manually views them.
// Path 2 bypasses this entirely by rendering server-side.

'use strict';

const { google } = require('googleapis');

// pdfjs-dist/legacy calls require('canvas') internally for its NodeCanvasFactory.
// We use @napi-rs/canvas (no system library deps, works on Vercel Lambda) instead.
// Patch Node's module resolver once at startup so pdfjs-dist transparently
// gets @napi-rs/canvas when it tries to load 'canvas'.
(function patchCanvasAlias() {
  const Module  = require('module');
  const origFn  = Module._resolveFilename.bind(Module);
  Module._resolveFilename = (request, ...args) =>
    request === 'canvas' ? origFn('@napi-rs/canvas', ...args) : origFn(request, ...args);
})();

// Large dependencies are loaded lazily so cold starts on path-1 hits stay fast.
// Module-level memoization keeps them loaded across warm invocations.
let _drive     = null;
let _pdfjsLib  = null;
let _createCanvas = null;

function getDrive() {
  if (_drive) return _drive;
  const auth = new google.auth.JWT({
    email:  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  _drive = google.drive({ version: 'v3', auth });
  return _drive;
}

function getPdfJs() {
  if (!_pdfjsLib) {
    // pdfjs-dist/legacy tries to require('canvas') to polyfill DOMMatrix and Path2D.
    // Inject from @napi-rs/canvas first so it finds real implementations.
    const napiCanvas = require('@napi-rs/canvas');
    if (!global.DOMMatrix) global.DOMMatrix = napiCanvas.DOMMatrix;
    if (!global.Path2D)    global.Path2D    = napiCanvas.Path2D;

    _pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    // No worker in serverless — disable it entirely
    _pdfjsLib.GlobalWorkerOptions.workerSrc = '';
  }
  return _pdfjsLib;
}

function getCreateCanvas() {
  if (!_createCanvas) {
    // @napi-rs/canvas: Rust/Skia-based, no system library deps, works on Vercel Lambda
    _createCanvas = require('@napi-rs/canvas').createCanvas;
  }
  return _createCanvas;
}

// Skip PDF rendering for files larger than this (avoids Lambda timeout)
const MAX_RENDER_BYTES = 30 * 1024 * 1024; // 30 MB

// Target thumbnail width in pixels
const THUMB_WIDTH = 400;

module.exports = async (req, res) => {
  const { id } = req.query;

  if (!id || !/^[\w-]{10,}$/.test(id)) {
    return res.status(400).send('Missing or invalid ?id= parameter.');
  }

  try {
    const drive = getDrive();

    // ── Path 1: thumbnailLink (fast) ───────────────────────────────────────
    const { data } = await drive.files.get({
      fileId: id,
      fields: 'thumbnailLink,size',
      supportsAllDrives: true,
    });

    if (data.thumbnailLink) {
      const imgRes = await fetch(data.thumbnailLink);
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        res.setHeader('Content-Type', imgRes.headers.get('content-type') || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
        return res.send(buf);
      }
    }

    // ── Path 2: render PDF page 1 server-side ─────────────────────────────
    const fileSizeBytes = parseInt(data.size || '0', 10);

    if (fileSizeBytes > 0 && fileSizeBytes <= MAX_RENDER_BYTES) {
      const thumbnail = await renderPdfThumbnail(drive, id);
      if (thumbnail) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
        return res.send(thumbnail);
      }
    }

    // ── Path 3: placeholder ────────────────────────────────────────────────
    return sendPlaceholder(res);

  } catch (err) {
    console.error('[/api/thumb] id=%s error=%s', id, err.message);
    return sendPlaceholder(res);
  }
};

// ── PDF rendering ─────────────────────────────────────────────────────────────

async function renderPdfThumbnail(drive, fileId) {
  try {
    // Download the full PDF as an ArrayBuffer
    const response = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );

    const pdfData = new Uint8Array(response.data);

    const pdfjsLib    = getPdfJs();
    const createCanvas = getCreateCanvas();

    const pdf = await pdfjsLib.getDocument({
      data: pdfData,
      // Skip font loading — thumbnails don't need pixel-perfect text
      disableFontFace: true,
      cMapUrl: null,
      cMapPacked: false,
      standardFontDataUrl: null,
    }).promise;

    const page         = await pdf.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale        = THUMB_WIDTH / baseViewport.width;
    const viewport     = page.getViewport({ scale });

    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const ctx    = canvas.getContext('2d');

    // White background (PDFs are transparent by default, canvas is black)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;

    return canvas.toBuffer('image/jpeg', { quality: 0.85 });

  } catch (err) {
    console.error('[/api/thumb] renderPdfThumbnail failed:', err.message);
    return null;
  }
}

// ── Placeholder SVG ───────────────────────────────────────────────────────────

function sendPlaceholder(res) {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="520" viewBox="0 0 400 520">',
    '  <rect width="400" height="520" fill="#f6f6f6"/>',
    '  <rect x="145" y="135" width="110" height="140" rx="4" fill="none" stroke="#d0d0d0" stroke-width="2"/>',
    '  <path d="M225 135 L255 165 L225 165 Z" fill="#d0d0d0"/>',
    '  <path d="M225 135 L255 165 L225 165" fill="none" stroke="#d0d0d0" stroke-width="2"/>',
    '  <line x1="165" y1="195" x2="235" y2="195" stroke="#d0d0d0" stroke-width="2"/>',
    '  <line x1="165" y1="210" x2="235" y2="210" stroke="#d0d0d0" stroke-width="2"/>',
    '  <line x1="165" y1="225" x2="215" y2="225" stroke="#d0d0d0" stroke-width="2"/>',
    '  <text x="200" y="330" font-family="sans-serif" font-size="13" fill="#c0c0c0" text-anchor="middle">No preview available</text>',
    '</svg>',
  ].join('\n');

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).send(svg);
}
