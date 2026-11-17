// The page inside the dashboard's sandboxed frame. It has an opaque origin: no credential, no storage, no network
// beyond its own files. It receives the sections of a visual from the dashboard and tells it what the reader does;
// every control that acts for the user is drawn by the dashboard, outside this page. See "Visuals" in
// docs/architecture.md.
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import {
  COMMENT_LIMITS,
  FORM_LIMITS,
  codeLanguage,
  parseBlocks,
  parseForm,
  parsePatch,
  parseScene,
  sceneMoments,
  sceneState,
  sceneVisible,
  visibleParts,
} from '/visual/format.js';
import { lineRow, locate } from '/visual/anchor.js';
import { createForms } from '/visual/form.js';
import { createMarks } from '/visual/marks.js';
import { createPatches } from '/visual/patch.js';
import { createRenderer, visualMarkdown } from '/visual/render.js';
import { createMotion, createScenes } from '/visual/scene.js';
import { createSheen } from '/visual/sheen.js';

const root = document.documentElement;
const container = document.getElementById('document');
// The frame's own origin is opaque, so the dashboard's origin is the one this page was loaded from.
const dashboardOrigin = new URL(location.href).origin;
const tell = (message) => window.parent.postMessage(message, dashboardOrigin);

const token = (name) => getComputedStyle(root).getPropertyValue(`--${name}`).trim();

let highlighter = null;
const languages = new Map();
async function highlight(code, name) {
  const language = codeLanguage(name);
  if (!language) return;
  highlighter ??= import('/vendor/highlight/core.js').then((module) => module.default);
  const hljs = await highlighter;
  if (!languages.has(language))
    languages.set(
      language,
      import(`/vendor/highlight/${language}.js`).then((module) => hljs.registerLanguage(language, module.default)),
    );
  await languages.get(language);
  // highlight.js escapes the code and adds only its own spans.
  code.innerHTML = hljs.highlight(code.textContent, { language, ignoreIllegals: true }).value;
  code.classList.add('hljs');
}

let mermaidLibrary = null;
let diagrams = 0;
function mermaidConfig() {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    // For a diagram that it cannot read, Mermaid would draw a picture of the error and leave it at the end of the
    // page. The renderer shows the reason in the place of the block.
    suppressErrorRendering: true,
    theme: 'base',
    fontFamily: token('font-body'),
    themeVariables: {
      darkMode: token('color-scheme') === 'dark',
      background: token('surface'),
      primaryColor: token('accent-soft'),
      primaryTextColor: token('ink'),
      primaryBorderColor: token('accent'),
      secondaryColor: token('markdown-body-th-surface'),
      tertiaryColor: token('canvas'),
      lineColor: token('muted'),
      edgeLabelBackground: token('surface'),
      textColor: token('ink'),
      mainBkg: token('accent-soft'),
      noteBkgColor: token('markdown-body-pre-surface'),
      noteTextColor: token('ink'),
      noteBorderColor: token('line'),
      fontFamily: token('font-body'),
    },
  };
}
async function mermaid(figure, block) {
  mermaidLibrary ??= import('/vendor/mermaid/mermaid.esm.min.mjs').then((module) => module.default);
  const library = await mermaidLibrary;
  library.initialize(mermaidConfig());
  diagrams += 1;
  const { svg } = await library.render(`diagram-${diagrams}`, block.text);
  figure.innerHTML = svg;
}

const forms = createForms({ document, parseForm, answerChars: FORM_LIMITS.answerChars, tell });

const lessMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let scenes = null;
async function scene(figure, block) {
  scenes ??= import('/vendor/anime.js').then(({ createTimeline }) =>
    createScenes({
      document,
      parseScene,
      sceneState,
      sceneMoments,
      sceneVisible,
      motion: createMotion({ createTimeline }),
      reducedMotion: () => lessMotion.matches,
    }),
  );
  (await scenes).render(figure, block);
}

const patches = createPatches({ document, parsePatch, visibleParts });

const renderer = createRenderer({
  document,
  parseBlocks,
  markdownHtml: (source) => visualMarkdown(source, { parse: marked.parse, sanitize: DOMPurify.sanitize }),
  highlight,
  richBlocks: { mermaid, form: forms.render, scene, patch: patches.render },
  onProblems: (problems) => tell({ type: 'problems', problems }),
});

const marks = createMarks({ document, window, container, limits: COMMENT_LIMITS, tell });
const sheen = createSheen({ document, window, container, locate, lineRow });

function applyTokens(tokens) {
  for (const [name, value] of Object.entries(tokens))
    if (/^[a-z0-9-]+$/.test(name) && typeof value === 'string') root.style.setProperty(`--${name}`, value);
}

let shown = null;
function activeSection() {
  let active = null;
  for (const section of container.children) {
    if (section.getBoundingClientRect().top > window.innerHeight * 0.35) break;
    active = section;
  }
  return /** @type {HTMLElement | null} */ (active ?? container.firstElementChild)?.dataset.section ?? null;
}
let lastActive = null;
let scheduled = false;
function reportActive() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    const active = activeSection();
    if (active === lastActive) return;
    lastActive = active;
    tell({ type: 'active', sectionId: active });
  });
}
window.addEventListener('scroll', reportActive, { passive: true });
window.addEventListener('resize', reportActive);
// A diagram that finishes drawing, or a new text size, moves the sections without a scroll.
new ResizeObserver(reportActive).observe(container);

// No link navigates the frame: the dashboard shows the address and the user decides. A link of a diagram is an SVG
// element, which names its target in the XLink attribute.
container.addEventListener('click', (event) => {
  const link = /** @type {Element} */ (event.target).closest?.('a');
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute('href') ?? link.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
  if (href === null) return;
  if (href.startsWith('#')) document.getElementById(`section-${href.slice(1)}`)?.scrollIntoView({ behavior: 'smooth' });
  else tell({ type: 'link', href });
});

// The dashboard asks for a place when the user clicks a section in its list, or a question in the list of answers.
// The place can be in view already, where no scroll shows it, so it also flashes.
function showPlace({ sectionId, field }) {
  const section = document.getElementById(`section-${sectionId}`);
  if (!section) return;
  const question =
    typeof field === 'string'
      ? [...section.querySelectorAll('.form-field')].find((item) => item.getAttribute('data-field') === field)
      : undefined;
  const place = /** @type {HTMLElement} */ (question ?? section);
  place.scrollIntoView({ behavior: 'smooth', block: question ? 'center' : 'start' });
  place.classList.remove('flash');
  // Reading the box starts the animation again when the same place is asked for twice in a row.
  void place.offsetWidth;
  place.classList.add('flash');
}

// A key pressed inside the frame never reaches the dashboard, so the dashboard's shortcut for the lead's chat is
// passed on. The frame cannot ask the dashboard whether it honors the key, and the browser must be refused the key
// now, so the frame applies the rule itself. The function is a copy of `isLeadChatShortcut` in public/model.js, which
// the frame cannot load (a new file would need the service to restart); a test keeps the two equal.
function isLeadChatShortcut(event, mac) {
  if (event.repeat || event.isComposing || event.shiftKey || event.altKey) return false;
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return false;
  const key = String(event.key);
  return key.toLowerCase() === 'l' || (!/^[a-z]$/i.test(key) && event.code === 'KeyL');
}
const macKeyboard = /^Mac/i.test(navigator.platform);
window.addEventListener('keydown', (event) => {
  if (!isLeadChatShortcut(event, macKeyboard)) return;
  event.preventDefault();
  const { key, code, metaKey, ctrlKey, shiftKey, altKey, repeat, isComposing } = event;
  tell({ type: 'key', key, code, metaKey, ctrlKey, shiftKey, altKey, repeat, isComposing });
});

window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.origin !== dashboardOrigin) return;
  const message = event.data;
  if (message?.type === 'render') {
    if (message.tokens) applyTokens(message.tokens);
    shown = { sections: message.sections };
    renderer.render(container, { sections: message.sections, flash: message.flash ?? [] });
    marks.apply();
    sheen.apply();
    if (message.top) window.scrollTo(0, 0);
    reportActive();
  } else if (message?.type === 'theme') {
    applyTokens(message.tokens);
    // A diagram is drawn in the colors of its time, so everything is drawn again.
    renderer.reset();
    if (shown) renderer.render(container, shown);
  } else if (message?.type === 'answers') {
    forms.set(container, message);
  } else if (message?.type === 'comments') {
    marks.set(message.comments, message.active ?? null);
  } else if (message?.type === 'working') {
    sheen.set(message.targets);
  } else if (message?.type === 'reveal') {
    marks.reveal(message.id);
  } else if (message?.type === 'scrollTo') {
    showPlace(message);
  }
});

tell({ type: 'ready' });
