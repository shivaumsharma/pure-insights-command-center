// Serves the built React app (frontend/dist) from the same origin as the API, so `npm start` is the whole product.
// Skipped silently when the UI has not been built; the API still works on its own.

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

// Same-origin scripts only. Styles and fonts come from Google Fonts (the three free fonts in docs/design-system.md).
// connect-src allows the WebSocket on this origin.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const API_PREFIXES = ['/api', '/healthz', '/ws'];
const isApiPath = (p) => API_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));

export function staticUi(dir) {
  const index = path.join(dir, 'index.html');
  if (!fs.existsSync(index)) return null;

  const files = express.static(dir, {
    index: false,
    dotfiles: 'ignore',
    setHeaders(res, file) {
      // Vite fingerprints everything in /assets, so those files can be cached forever. index.html must never be.
      res.set('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-store');
    },
  });

  // Any page address the browser asks for gets the app shell; the router in the browser takes it from there.
  const fallback = (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || isApiPath(req.path) || path.extname(req.path)) return next();
    if (!(req.get('accept') ?? '').includes('text/html')) return next();
    res.set({
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-store',
    });
    return res.sendFile(index);
  };

  return [files, fallback];
}
