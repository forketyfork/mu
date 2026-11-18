// The frame of an HTML attachment. It asks the dashboard for the page, writes the page in place of its own document
// and reports how tall the page is. The page is agent code: it keeps this frame's opaque origin and policy, which allow
// no connection. See "HTML attachments" in docs/architecture.md.
const host = window.parent;

// The height of what the page drew. The root element's own scroll height is never less than the frame, so it could
// not shrink; a page sized by the frame (height: 100%) reports the frame's height and keeps it.
function report() {
  const root = document.documentElement;
  const height = Math.max(root?.getBoundingClientRect().height ?? 0, document.body?.scrollHeight ?? 0);
  host.postMessage({ type: 'size', height: Math.ceil(height) }, '*');
}

function show(html) {
  document.open();
  document.write(html);
  document.close();
  new ResizeObserver(report).observe(document.documentElement);
  if (document.body) new ResizeObserver(report).observe(document.body);
  report();
}

// Opened outside the dashboard, the page has nobody to ask and stays empty.
if (host !== window) {
  window.addEventListener('message', function receive(event) {
    if (event.source !== host || event.data?.type !== 'page' || typeof event.data.html !== 'string') return;
    window.removeEventListener('message', receive);
    show(event.data.html);
  });
  host.postMessage({ type: 'ready' }, '*');
}
