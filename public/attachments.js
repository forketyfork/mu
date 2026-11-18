// HTML attachments of chat messages: the frame that runs each one under its message. The page is agent code, so it runs
// only after the user's click, in a sandboxed frame with an opaque origin and a policy without network. The dashboard
// draws everything around the frame, and takes from it only a request for the page and a height, which it bounds.
// See "HTML attachments" in docs/architecture.md.
import { formatBytes } from './model.js';

export const ATTACHMENT_PAGE = '/attachment/frame.html';
const MIN_HEIGHT = 48;
const MAX_HEIGHT = 640;

/**
 * @param {object} options
 * @param {Document} options.document
 * @param {Window} options.window
 * @param {(path: string) => Promise<any>} options.request Reads the API with the user's credential.
 */
export function createAttachments({ document, window, request }) {
  /** Message ID → the figure whose frame runs that message's page. @type {Map<number, HTMLElement>} */
  const running = new Map();
  /**
   * The parts of each figure: its message, and while it runs, its frame, the shield over the frame, the height its
   * page reported, and whether the frame got its page since Mu last loaded it.
   * @type {WeakMap<HTMLElement, { message: any, frame: HTMLIFrameElement | null, shield: HTMLButtonElement | null, height: string, served: boolean }>}
   */
  const parts = new WeakMap();
  /** @type {Map<number, Promise<string>>} */
  const pages = new Map();
  // The figure whose page the user gave the keyboard to, and the dashboard element that had the focus last.
  /** @type {HTMLElement | null} */
  let engaged = null;
  /** @type {HTMLElement | null} */
  let lastFocus = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let watch = null;

  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const button = (className, text, label) => {
    const element = node('button', `text-button ${className}`, text);
    element.type = 'button';
    element.setAttribute('aria-label', label);
    return element;
  };
  const page = (id) => {
    if (!pages.has(id))
      pages.set(
        id,
        request(`/api/messages/${id}/attachment`).then(
          (attachment) => attachment.html,
          (error) => {
            pages.delete(id);
            throw error;
          },
        ),
      );
    return pages.get(id);
  };
  const fail = (figure, error) => {
    figure.classList.add('failed');
    figure.querySelector('.message-attachment-error').textContent =
      `The attachment could not be loaded: ${error.message}`;
  };

  function startBox(figure) {
    const { message } = parts.get(figure);
    const waiting = node('div', 'message-attachment-start');
    const run = node('button', 'button secondary message-attachment-run', 'Run');
    run.type = 'button';
    run.setAttribute('aria-label', `Run the HTML page ${message.attachment.title} from ${message.from}`);
    run.addEventListener('click', () => start(figure));
    waiting.append(
      run,
      node(
        'span',
        'message-attachment-note',
        `A page that ${message.from} wrote. It runs in a sandbox without access to Mu or your sign-in.`,
      ),
    );
    return waiting;
  }

  /**
   * Runs the page of the figure on the user's click, and gives it the keyboard.
   * @param {HTMLElement} figure
   */
  function start(figure) {
    const part = parts.get(figure);
    figure.classList.remove('stopped');
    figure.classList.add('running');
    figure.querySelector('.message-attachment-start')?.remove();
    for (const control of figure.querySelectorAll('.message-attachment-bar button'))
      /** @type {HTMLButtonElement} */ (control).hidden = false;
    const stage = node('div', 'message-attachment-stage');
    const frame = document.createElement('iframe');
    frame.className = 'message-attachment-frame';
    frame.title = `HTML attachment ${part.message.attachment.title} from ${part.message.from}`;
    frame.setAttribute('sandbox', 'allow-scripts');
    // The user's click on Run is in the dashboard, never in the page. Delegating autoplay lets the page's audio start
    // on that click; without it the browser keeps the audio suspended until the user clicks or types in the page.
    frame.setAttribute('allow', "autoplay; picture-in-picture 'none'");
    frame.setAttribute('loading', 'lazy');
    frame.referrerPolicy = 'no-referrer';
    // Tab passes over the page; the shield is the way in by keyboard.
    frame.tabIndex = -1;
    frame.addEventListener('load', () => {
      if (engaged === figure) frame.contentWindow.focus();
    });
    frame.src = ATTACHMENT_PAGE;
    const shield = /** @type {HTMLButtonElement} */ (node('button', 'message-attachment-shield'));
    shield.type = 'button';
    shield.setAttribute('aria-label', `Use the page ${part.message.attachment.title}`);
    shield.title = 'Click to use the page';
    shield.addEventListener('click', () => engage(figure));
    stage.append(frame, shield);
    figure.append(stage);
    Object.assign(part, { frame, shield, served: false });
    running.set(part.message.id, figure);
    watch ??= setInterval(() => guard(true), 200);
    engage(figure);
  }

  // The user gives the page the keyboard: the shield over it goes away until the focus leaves it.
  function engage(figure) {
    if (engaged && engaged !== figure) disengage();
    const part = parts.get(figure);
    engaged = figure;
    part.shield.hidden = true;
    part.frame.focus();
  }

  function disengage() {
    const shield = engaged && parts.get(engaged)?.shield;
    if (shield) shield.hidden = false;
    engaged = null;
  }

  /**
   * Ends the page of the figure and says why; the user can run it again.
   * @param {HTMLElement} figure
   * @param {string} reason
   */
  function stop(figure, reason) {
    const part = parts.get(figure);
    if (figure.matches(':popover-open')) setExpanded(figure, false);
    if (engaged === figure) engaged = null;
    part.frame?.closest('.message-attachment-stage')?.remove();
    Object.assign(part, { frame: null, shield: null, height: '', served: false });
    running.delete(part.message.id);
    figure.classList.remove('running');
    figure.classList.add('stopped');
    for (const control of figure.querySelectorAll('.message-attachment-bar button'))
      /** @type {HTMLButtonElement} */ (control).hidden = true;
    figure.querySelector('.message-attachment-bar').after(startBox(figure));
    figure.querySelector('.message-attachment-error').textContent = reason;
  }

  // A page may have the keyboard only after the user gave it: a page that takes the focus itself would get what the
  // user types into the dashboard. Such a page is stopped, and the focus goes back where it was. The window's blur
  // reports a frame that takes the focus from the dashboard; the poll, one that takes it from another frame. A window
  // event comes while the focus is still moving, when the active element can be the body for a moment, so only a
  // settled state (a `focusin`, the poll) can say that the frame lost the keyboard.
  function guard(settled = true) {
    const active = document.activeElement;
    const thief = [...running.values()].find((figure) => figure !== engaged && parts.get(figure).frame === active);
    if (thief) {
      const back = engaged ? parts.get(engaged).frame : lastFocus;
      stop(thief, 'Mu stopped this page because it took the keyboard without your click.');
      if (back?.isConnected) back.focus();
    } else if (settled && engaged && (!engaged.isConnected || parts.get(engaged).frame !== active)) disengage();
    if (!running.size && watch) {
      clearInterval(watch);
      watch = null;
    }
  }

  // In the larger view the frame fills the popover; back in the message it takes the height its page reported.
  function setExpanded(figure, expanded) {
    const toggle = figure.querySelector('.message-attachment-expand');
    const part = parts.get(figure);
    if (expanded) figure.showPopover();
    else figure.hidePopover();
    if (part.frame) part.frame.style.height = expanded ? '' : part.height;
    toggle.textContent = expanded ? 'Close' : 'Larger';
    toggle.setAttribute('aria-label', expanded ? 'Show the attachment in the message' : 'Show the attachment larger');
  }

  /**
   * The figure of a message's attachment, without its frame: the page runs when the user clicks Run.
   * @param {any} message
   */
  function element(message) {
    const { title, bytes } = message.attachment;
    const figure = node('figure', 'message-attachment');
    figure.dataset.attachment = String(message.id);
    // A popover is drawn above the page without leaving its place in the document, so the frame keeps running.
    figure.popover = 'manual';
    const bar = node('figcaption', 'message-attachment-bar');
    const restart = button('message-attachment-restart', 'Restart', 'Run the attachment again from the start');
    const expand = button('message-attachment-expand', 'Larger', 'Show the attachment larger');
    restart.hidden = expand.hidden = true;
    bar.append(
      node('span', 'message-attachment-kind', 'HTML'),
      node('span', 'message-attachment-title', title),
      node('span', 'message-attachment-size', formatBytes(bytes)),
      restart,
      expand,
    );
    restart.addEventListener('click', () => {
      const part = parts.get(figure);
      if (!part.frame) return;
      part.served = false;
      part.frame.src = ATTACHMENT_PAGE;
      engage(figure);
    });
    expand.addEventListener('click', () => setExpanded(figure, !figure.matches(':popover-open')));
    figure.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && figure.matches(':popover-open')) setExpanded(figure, false);
    });
    parts.set(figure, { message, frame: null, shield: null, height: '', served: false });
    figure.append(bar, startBox(figure), node('p', 'message-attachment-error'));
    return figure;
  }

  /**
   * Gives the figures in `container` that have no frame yet the frame of their message. A figure whose message has a
   * frame running elsewhere in the page is replaced by that figure, moved without reloading, so a rebuilt chat does
   * not restart its pages. The others wait for Run, also after a switch to another conversation and back: a page
   * that runs without the user's click, and focuses itself on load as keyboard games do, would be stopped for it.
   * @param {HTMLElement} container
   */
  function settle(container) {
    for (const figure of /** @type {NodeListOf<HTMLElement>} */ (container.querySelectorAll('.message-attachment'))) {
      const part = parts.get(figure);
      if (!part || part.frame) continue;
      const previous = running.get(part.message.id);
      if (previous && previous !== figure && previous.isConnected && 'moveBefore' in figure.parentElement) {
        figure.parentElement.moveBefore(previous, figure);
        figure.remove();
      }
    }
    for (const [id, figure] of running) if (!figure.isConnected) running.delete(id);
  }

  /**
   * Replaces the children of `container` with `fragment`, carrying over the running frames.
   * @param {HTMLElement} container
   * @param {DocumentFragment} fragment
   */
  function replace(container, fragment) {
    if (!running.size) {
      container.replaceChildren(fragment);
      settle(container);
      return;
    }
    const previous = [...container.childNodes];
    container.append(fragment);
    settle(container);
    for (const child of previous) child.remove();
    for (const [id, figure] of running) if (!figure.isConnected) running.delete(id);
  }

  document.addEventListener('focusin', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target.tagName !== 'IFRAME') lastFocus = target;
    guard(true);
  });
  window.addEventListener('blur', () => guard(false));
  window.addEventListener('focus', () => guard(false));

  // Each message is matched to its frame by the window it came from; anything else in it is ignored. A frame gets its
  // page once per load that Mu started, so a page cannot make the dashboard copy it again and again.
  window.addEventListener('message', (event) => {
    const figure = [...running.values()].find((item) => parts.get(item).frame?.contentWindow === event.source);
    if (!figure || typeof event.data !== 'object' || event.data === null) return;
    const part = parts.get(figure);
    if (event.data.type === 'ready' && !part.served) {
      part.served = true;
      page(part.message.id).then(
        (html) => part.frame?.contentWindow?.postMessage({ type: 'page', html }, '*'),
        (error) => fail(figure, error),
      );
    } else if (event.data.type === 'size' && Number.isFinite(event.data.height)) {
      part.height = `${Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, event.data.height)))}px`;
      if (!figure.matches(':popover-open')) part.frame.style.height = part.height;
    }
  });

  return { element, settle, replace };
}
