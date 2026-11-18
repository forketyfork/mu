// What a browser may do with Mu's pages: the content security policy of the dashboard, and the policy and the files
// of the frame that draws a visual. The frame check in tests/browser/ covers this file in a real browser, and the
// pre-commit hook runs that check when this file changes.
import { CODE_LANGUAGES } from './visual-format.mjs';

// See "Visuals" in docs/architecture.md. The dashboard may embed only Mu's own pages, and the frame-src rule also
// governs where an embedded frame can navigate itself.
export const PAGE_POLICY =
  "default-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; script-src 'self'; frame-src 'self'; frame-ancestors 'none'";
// The page that renders a visual's content, written by agents. The sandbox directive gives it an opaque origin even
// when it is opened outside the dashboard's sandboxed frame, and nothing in the policy allows a connection.
const FRAME_PAGE = '/visual/frame.html';
export const FRAME_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts";
// The page that runs an HTML attachment of a chat message, which is agent code by design. It runs the page's inline
// scripts and styles, and nothing in the policy allows a connection, a frame, a form or a remote image, font or sound.
// See "HTML attachments" in docs/architecture.md.
const ATTACHMENT_PAGE = '/attachment/frame.html';
export const ATTACHMENT_POLICY =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts";
// Every file the frames load, by its URL path; a frame gets no other file. A page carries its own policy. highlight.js
// publishes its core as CommonJS only, so that file is served inside a module wrapper.
/** @typedef {{ file: string, policy?: string, commonJs?: boolean }} FrameAsset */
/** @type {Readonly<Record<string, FrameAsset>>} */
const FRAME_ASSETS = Object.freeze({
  [FRAME_PAGE]: { file: 'public/visual/frame.html', policy: FRAME_POLICY },
  '/visual/frame.css': { file: 'public/visual/frame.css' },
  '/visual/frame.js': { file: 'public/visual/frame.js' },
  '/visual/render.js': { file: 'public/visual/render.js' },
  '/visual/anchor.js': { file: 'public/visual/anchor.js' },
  '/visual/marks.js': { file: 'public/visual/marks.js' },
  '/visual/sheen.js': { file: 'public/visual/sheen.js' },
  '/visual/form.js': { file: 'public/visual/form.js' },
  '/visual/scene.js': { file: 'public/visual/scene.js' },
  '/visual/patch.js': { file: 'public/visual/patch.js' },
  '/visual/format.js': { file: 'src/visual-format.mjs' },
  // The format imports its parts by their file names.
  '/visual/visual-spec.mjs': { file: 'src/visual-spec.mjs' },
  '/visual/visual-scene.mjs': { file: 'src/visual-scene.mjs' },
  '/visual/visual-patch.mjs': { file: 'src/visual-patch.mjs' },
  '/vendor/marked.js': { file: 'node_modules/marked/lib/marked.esm.js' },
  '/vendor/purify.js': { file: 'node_modules/dompurify/dist/purify.es.mjs' },
  '/vendor/anime.js': { file: 'node_modules/animejs/dist/bundles/anime.esm.min.js' },
  '/vendor/highlight/core.js': { file: 'node_modules/highlight.js/lib/core.js', commonJs: true },
  ...Object.fromEntries(
    CODE_LANGUAGES.map((language) => [
      `/vendor/highlight/${language}.js`,
      { file: `node_modules/highlight.js/es/languages/${language}.js` },
    ]),
  ),
  [ATTACHMENT_PAGE]: { file: 'public/attachment/frame.html', policy: ATTACHMENT_POLICY },
  '/attachment/frame.js': { file: 'public/attachment/frame.js' },
});
// The directories of public/ that hold frame files: they answer only at the paths listed above.
export const FRAME_DIRECTORIES = Object.freeze(['visual', 'attachment']);
// Mermaid loads the code of a diagram type when a diagram first needs it, from files it names itself.
const MERMAID_FILE = /^\/vendor\/mermaid\/(mermaid\.esm\.min\.mjs|chunks\/mermaid\.esm\.min\/[A-Za-z0-9_-]+\.mjs)$/;
/**
 * The file that answers a request of the frame for `pathname`, or null: the frame gets no other file.
 * @param {string} pathname
 * @returns {FrameAsset | null}
 */
export function frameAssetOf(pathname) {
  if (Object.hasOwn(FRAME_ASSETS, pathname)) return FRAME_ASSETS[pathname];
  const mermaid = MERMAID_FILE.exec(pathname);
  return mermaid ? { file: `node_modules/mermaid/dist/${mermaid[1]}` } : null;
}
export const commonJsModule = (source) =>
  `const module = { exports: {} };\n(function (module, exports) {\n${source}\n})(module, module.exports);\nexport default module.exports;\n`;
