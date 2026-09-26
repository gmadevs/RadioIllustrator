import { defineConfig, type Plugin } from 'vite'

/**
 * Content Security Policy for the published build. `connect-src 'none'` makes
 * the browser refuse every fetch, XHR, WebSocket and beacon from the page, so
 * DICOM data cannot be sent anywhere even by mistake. Scripts and styles load
 * only from the site itself. The dev server is left without it, because Vite's
 * hot reload needs a WebSocket.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      ),
  }
}

// Relative base so the build also works from a subfolder (GitHub Pages) or file server.
export default defineConfig({
  base: './',
  // The preload polyfill uses fetch(); with a single bundle there is nothing to preload.
  build: { modulePreload: { polyfill: false } },
  plugins: [contentSecurityPolicy()],
})
