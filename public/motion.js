export function themeValue(element, name) {
  const { documentElement, defaultView } = element.ownerDocument;
  const value = defaultView.getComputedStyle(documentElement).getPropertyValue(`--${name}`).trim();
  if (!value) throw new Error(`Missing theme token: ${name}`);
  return value;
}

export function stateChanges(previous, next) {
  const changes = { messages: new Set(), agents: new Set(), tasks: new Set() };
  if (!previous) return changes;
  // Message IDs increase across conversations; restored history must not look like a live arrival.
  const lastMessageId = previous.messages.reduce((latest, message) => Math.max(latest, message.id), 0);
  for (const message of next.messages) if (message.id > lastMessageId) changes.messages.add(message.id);
  for (const kind of ['agents', 'tasks']) {
    const statuses = new Map((previous[kind] ?? []).map((item) => [item.id, item.status]));
    for (const item of next[kind] ?? []) {
      if (statuses.has(item.id) && statuses.get(item.id) !== item.status) changes[kind].add(item.id);
    }
  }
  return changes;
}

export function createMotion(preference = window.matchMedia('(prefers-reduced-motion: reduce)')) {
  const active = new Map();

  function cancelAll() {
    for (const animation of active.values()) animation.cancel();
    active.clear();
  }

  preference.addEventListener('change', () => {
    if (preference.matches) cancelAll();
  });

  return {
    cancelAll,
    get scrollBehavior() {
      return preference.matches ? 'instant' : 'smooth';
    },
    play(element, kind, key = element) {
      active.get(key)?.cancel();
      active.delete(key);
      if (preference.matches) return;
      const read = (name) => themeValue(element, `motion-${name}`);
      const frames =
        kind === 'status'
          ? [
              { boxShadow: read('status-start') },
              { boxShadow: read('status-peak'), offset: 0.3 },
              { boxShadow: read('status-end') },
            ]
          : [
              {
                opacity: Number(read(`${kind}-opacity`)),
                ...(kind === 'message' ? { transform: `translateY(${read('message-offset')})` } : {}),
              },
              { opacity: 1, ...(kind === 'message' ? { transform: 'none' } : {}) },
            ];
      const animation = element.animate(frames, {
        id: `mu-${kind}`,
        duration: Number.parseFloat(read(`${kind}-duration`)),
        easing: read('easing'),
      });
      active.set(key, animation);
      const release = () => {
        if (active.get(key) === animation) active.delete(key);
      };
      animation.addEventListener('finish', release, { once: true });
      animation.addEventListener('cancel', release, { once: true });
    },
    // Grows an element from a rectangle, such as the card it expands, to its own box by revealing it with a clip,
    // so the text is never scaled. Resolves when the effect ends; with reduced motion or no origin it ends at once.
    expand(element, origin, { reverse = false } = {}) {
      active.get(element)?.cancel();
      active.delete(element);
      if (preference.matches || !origin) return Promise.resolve();
      const box = element.getBoundingClientRect();
      const read = (name) => themeValue(element, `motion-${name}`);
      const inset = `inset(${Math.max(0, origin.top - box.top)}px ${Math.max(0, box.right - origin.right)}px ${Math.max(0, box.bottom - origin.bottom)}px ${Math.max(0, origin.left - box.left)}px round ${read('origin-radius')})`;
      const frames = [{ clipPath: inset }, { clipPath: `inset(0px round ${read('dialog-radius')})` }];
      const options = {
        id: 'mu-expand',
        duration: Number.parseFloat(read('expand-duration')),
        easing: read('easing'),
        direction: reverse ? 'reverse' : 'normal',
        fill: 'both',
      };
      const animation = element.animate(frames, options);
      const backdrop = element.animate([{ opacity: 0 }, { opacity: 1 }], {
        ...options,
        id: 'mu-expand-backdrop',
        pseudoElement: '::backdrop',
      });
      // cancelAll must stop the backdrop together with the clip.
      const entry = {
        effect: animation.effect,
        cancel() {
          animation.cancel();
          backdrop.cancel();
        },
      };
      active.set(element, entry);
      return new Promise((resolve) => {
        const done = () => {
          if (active.get(element) === entry) active.delete(element);
          resolve();
        };
        animation.addEventListener('finish', done, { once: true });
        animation.addEventListener('cancel', done, { once: true });
      });
    },
    // State updates replace DOM nodes. Keep running effects at the same point on the replacement node.
    retarget(element, key) {
      const animation = active.get(key);
      if (animation) animation.effect.target = element;
    },
  };
}
