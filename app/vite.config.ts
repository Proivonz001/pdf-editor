import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";
import { VitePWA } from "vite-plugin-pwa";

// Everything runs on the device, and this policy backs that up: the app may load only its own
// files and may not connect to other sites (fetch, XHR, WebSocket, beacons, images, fonts).
// Where it applies:
// - Cloudflare sends it as a header (public/_headers): it covers the page and all its workers,
//   the service worker included.
// - The build also writes it into index.html as a <meta> tag, for any other static host. A
//   <meta> policy covers only the page, but the engine worker is started from a blob: URL
//   (src/engine/client.ts) and so inherits it on any host. There the service worker (Workbox,
//   which only caches the app's own files) has no policy.
// CSP does not govern top-level navigation or WebRTC: it limits what a bug or a compromised
// dependency could do, it is not an absolute guarantee. The app itself sends nothing anywhere.
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' data: blob:",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export default defineConfig({
  // Relative paths: the same build works at a domain root and in a sub-folder.
  base: "./",
  plugins: [
    preact(),
    {
      name: "csp-meta",
      apply: "build",
      transformIndexHtml: (html) =>
        html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}">`),
    },
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["icons/icon.svg", "icons/apple-touch-icon.png"],
      manifest: {
        // Working name until the product is named.
        name: "PDF Editor",
        short_name: "PDF Editor",
        description: "Edit the real text of a PDF, on any device. Your file never leaves it.",
        lang: "en",
        start_url: "./",
        scope: "./",
        display: "standalone",
        background_color: "#f5f6f8",
        theme_color: "#2747d8",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        // Desktop Chromium: "Open with" for PDF files once the app is installed (see src/platform/launch.ts).
        file_handlers: [{ action: "./", accept: { "application/pdf": [".pdf"] } }],
      },
      workbox: {
        // The PDF engine (about 10 MB of WebAssembly) is cached too, so the app works offline.
        globPatterns: ["**/*.{js,css,html,wasm,png,svg,webmanifest}"],
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  worker: { format: "es" },
  // mupdf uses top-level await and loads its .wasm next to itself: keep it out of pre-bundling.
  optimizeDeps: { exclude: ["mupdf"] },
  build: { target: "es2022", sourcemap: true },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    // The service-worker module only exists inside a Vite build: tests get a stand-in.
    alias: { "virtual:pwa-register": fileURLToPath(new URL("./tests/stubs/pwa-register.ts", import.meta.url)) },
  },
});
