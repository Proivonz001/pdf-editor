# PDF Editor (new version)

The rewrite of PDF Editor: it edits the **real text** of a PDF, in the file's own fonts, on a
computer or a phone. It can be installed as an app, works offline, and the file never leaves
the device: there is no server, all the work happens in the browser.

What it does is listed in the [repository README](../README.md). The first single-file editor
(`index.html` + `lib/` at the repository root) is still there, no longer developed.

"PDF Editor" is a **working name** until the product is named. It appears in
`vite.config.ts` (manifest), `index.html` (title), `../wrangler.jsonc` (`name`, which is also
the Cloudflare address) and the interface texts.

## Develop

Requires Node.js 22 or later and **npm 11**. npm 10.9 (the one bundled with Node 22) fails to
install this project with `Cannot read properties of null (reading 'edgesOut')`, an npm bug
triggered by vitest's optional peer dependencies. Either update npm once
(`npm install --global npm@11.6.2`) or run the install through npx
(`npx -y npm@11.6.2 ci`); the other commands work with any npm.

From this folder (`app/`):

| Command | What it does |
|---|---|
| `npm ci` | Install the exact dependency versions from `package-lock.json`. |
| `npm run dev` | Development server with hot reload at http://localhost:5173 (no service worker). |
| `npm run build` | Production build into `dist/`: hashed JS and CSS, the 10 MB MuPDF engine, service worker, manifest, icons, `_headers`. |
| `npm run preview` | Serve `dist/` at http://localhost:4173, service worker included: the way to test install and offline. |
| `npm test` | Vitest in Node: the engine on the PDFs in `tests/fixtures/`, the interface logic with a fake engine (`ui.test.ts`), page sizes and thumbnail scales, and the CSP check. |
| `npm run typecheck` | `tsc --noEmit` over `src/`, `tests/` and `vite.config.ts`. |
| `npm run icons` | Redraw the icons in `public/icons/` (Python 3 with Pillow, `scripts/make_icons.py`). |

GitHub runs `npm ci`, `typecheck`, `test` and `build` on every pull request that touches
`app/` (`.github/workflows/app.yml`, job `check`), and a second job, `pdfa`, that converts the
test files to PDF/A and validates them with veraPDF (PDF/A-2b), in Docker.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md): MuPDF 1.27.0 (WebAssembly) in a Web Worker, a Preact
interface with signals, the contract between them in `src/engine/protocol.ts`.

Platform pieces (`src/platform/`, `public/`):

- `pwa.ts`: service worker registration. A new version waits until the user asks to reload,
  so it never interrupts an edit, and only the window where the user clicked Update reloads:
  other open windows keep working and load the new version the next time.
- `launch.ts`: "Open with" for PDF files on desktop Chrome and Edge once the app is
  installed (manifest `file_handlers` + `launchQueue`). The interface calls
  `onLaunchFiles(file => ...)` once at startup; when several files are opened at once it gets
  only the last PDF (the app holds one document). In browsers without the API it does nothing.
- `public/icons/`: app icons, drawn by `scripts/make_icons.py` (edit the geometry there, then
  `npm run icons`; it also writes `icon.svg`).
- `public/_headers`: security and cache headers for Cloudflare.

## Privacy

Nothing is uploaded: the PDF is read, edited and saved inside the browser, and the app sends
nothing anywhere. There are no analytics and no external fonts or scripts. A
Content-Security-Policy backs this up: the app may load only its own files and may not connect
to other sites (`connect-src 'self' data: blob:`), so a bug or a compromised dependency could
not simply send the document away with fetch, XHR, WebSocket, a beacon, an image or a font.

The policy is defined once, as `CSP` in `vite.config.ts`, and applies in two ways:

- on Cloudflare it is sent as a header by `public/_headers`, which covers the page and all its
  workers (the PDF engine and the service worker), together with `frame-ancestors 'none'` (no
  embedding in other sites; only possible as a header), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer` and a `Permissions-Policy` that turns off camera,
  microphone, location, payment and USB;
- the build also writes it into `index.html` as a `<meta>` tag, for any other static host. A
  `<meta>` policy covers only the page, but the PDF engine worker is started from a `blob:`
  URL (`src/engine/client.ts`), so it inherits the page's policy on any host. There the
  service worker (Workbox, which only caches the app's own files) runs without a policy.

What CSP does not cover: top-level navigation (a script could still send the whole tab to
another address) and WebRTC. So it is a strong second line of defence, not an absolute
guarantee; the first is that the app's own code never sends the document.

To change the policy, edit both `CSP` in `vite.config.ts` and the line in `public/_headers`:
`tests/csp.test.ts` fails if they differ. On Cloudflare, leave off any feature that injects
scripts into the page (Web Analytics automatic setup, Rocket Loader, Email Address
Obfuscation): the policy blocks them, as intended.

## Deploy

### Cloudflare Workers (main host)

The repository root has `wrangler.jsonc`: a Worker named `pdf-editor` with **static assets
only** (no server code) served from `app/dist`, falling back to `index.html` for unknown
paths. It fits the free plan. Cloudflare builds and deploys by itself on every push; GitHub
Actions only checks.

One-time setup in the Cloudflare dashboard (the menu names may shift slightly over time):

1. **Workers & Pages** → **Create application** → **Import a repository** (Get started).
2. Connect the GitHub account if asked, then pick this repository.
3. Configure the project:
   - **Project name**: `pdf-editor`. It must equal `name` in `wrangler.jsonc`, or the build
     fails.
   - **Build command**: `cd app && npx -y npm@11.6.2 ci && npm run build`
   - **Deploy command**: `npx wrangler deploy`
   - **Root directory**: leave empty (the repository root, where `wrangler.jsonc` is).
4. **Save and Deploy**. The app is then at `https://pdf-editor.<your-subdomain>.workers.dev`.
5. In the Worker: **Settings** → **Build** → **Branch control**: production branch `main`,
   and tick **Enable Preview Builds**. Every push to another branch (a pull request, for
   example) then gets its own preview URL, listed under **Previews** in the Worker and
   commented on the pull request by Cloudflare. Leave the preview command at its default.

Notes:

- The build image's npm is 10.9, hence `npx -y npm@11.6.2 ci` in the build command (see
  *Develop*). Its default Node.js (24) works; to pin it, add the build variable
  `NODE_VERSION` = `22` under **Settings** → **Build** → **Build Variables and Secrets**.
- A custom domain: **Settings** → **Domains & Routes** → **Add** → **Custom domain**.
- To check the headers after a deploy: `curl -I https://pdf-editor.<your-subdomain>.workers.dev/`
  must show `content-security-policy` with `frame-ancestors 'none'`.
- Deploy by hand from a computer, without the dashboard: `cd app && npm run build`, then
  from the repository root `npx wrangler login` (once) and `npx wrangler deploy`.

### GitHub Pages (fallback)

The build uses relative paths (`base: "./"`), so the same `dist/` also works in a sub-folder
such as `https://<user>.github.io/<repository>/`. Limits compared with Cloudflare: GitHub
Pages cannot send custom headers, so `_headers` is ignored (the `<meta>` CSP still applies,
but there is no `frame-ancestors`, `nosniff` or `Permissions-Policy`), and caching is
GitHub's (about 10 minutes).

1. Repository **Settings** → **Pages** → **Source**: **GitHub Actions**.
2. Add a workflow such as `.github/workflows/pages.yml`:

```yaml
name: Pages
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: false
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    defaults:
      run:
        working-directory: app
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: app/package-lock.json
      - run: npm install --global npm@11.6.2
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v5
        with:
          path: app/dist
      - id: deployment
        uses: actions/deploy-pages@v5
```

## License

AGPL-3.0-or-later, like the rest of the repository (MuPDF is AGPL). The components bundled in
the build and their licenses are listed in `../THIRD_PARTY_NOTICES.md`.
