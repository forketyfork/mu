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
  /** @type {WeakMap<HTMLElement, { message: any, frame: HTMLIFrameElement | null, height: string }>} */
  const parts = new WeakMap();
  /** @type {Map<number, Promise<string>>} */
  const pages = new Map();
  // The messages whose page the user ran since the dashboard loaded. A figure drawn again for one of them, after a
  // switch to another conversation and back, runs without another click.
  const ran = new Set();

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

  function start(figure) {
    const part = parts.get(figure);
    ran.add(part.message.id);
    figure.classList.add('running');
    figure.querySelector('.message-attachment-start').remove();
    for (const control of figure.querySelectorAll('.message-attachment-bar button'))
      /** @type {HTMLButtonElement} */ (control).hidden = false;
    const frame = document.createElement('iframe');
    frame.className = 'message-attachment-frame';
    frame.title = `HTML attachment ${part.message.attachment.title} from ${part.message.from}`;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('loading', 'lazy');
    frame.referrerPolicy = 'no-referrer';
    frame.src = ATTACHMENT_PAGE;
    figure.append(frame);
    part.frame = frame;
    running.set(part.message.id, figure);
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
    const waiting = node('div', 'message-attachment-start');
    const run = node('button', 'button secondary message-attachment-run', 'Run');
    run.type = 'button';
    run.setAttribute('aria-label', `Run the HTML page ${title} from ${message.from}`);
    run.addEventListener('click', () => start(figure));
    waiting.append(
      run,
      node(
        'span',
        'message-attachment-note',
        `A page that ${message.from} wrote. It runs in a sandbox without access to Mu or your sign-in.`,
      ),
    );
    restart.addEventListener('click', () => {
      const frame = parts.get(figure).frame;
      if (frame) frame.src = ATTACHMENT_PAGE;
    });
    expand.addEventListener('click', () => setExpanded(figure, !figure.matches(':popover-open')));
    figure.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && figure.matches(':popover-open')) setExpanded(figure, false);
    });
    figure.append(bar, waiting, node('p', 'message-attachment-error'));
    parts.set(figure, { message, frame: null, height: '' });
    return figure;
  }

  /**
   * Gives the figures in `container` that have no frame yet the frame of their message. A figure whose message has a
   * frame running elsewhere in the page is replaced by that figure, moved without reloading, so a rebuilt chat does
   * not restart its pages. One whose page the user ran before starts again; the others wait for Run.
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
      } else if (ran.has(part.message.id)) start(figure);
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

  // Each message is matched to its frame by the window it came from; anything else in it is ignored.
  window.addEventListener('message', (event) => {
    const figure = [...running.values()].find((item) => parts.get(item).frame?.contentWindow === event.source);
    if (!figure || typeof event.data !== 'object' || event.data === null) return;
    const part = parts.get(figure);
    if (event.data.type === 'ready')
      page(part.message.id).then(
        (html) => part.frame.contentWindow?.postMessage({ type: 'page', html }, '*'),
        (error) => fail(figure, error),
      );
    else if (event.data.type === 'size' && Number.isFinite(event.data.height)) {
      part.height = `${Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, event.data.height)))}px`;
      if (!figure.matches(':popover-open')) part.frame.style.height = part.height;
    }
  });

  return { element, settle, replace };
}
