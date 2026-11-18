# Development

Mu is plain JavaScript on Node.js, type-checked through JSDoc, with no build step. The rules for changing Mu, for people and agents alike, are in [AGENTS.md](../AGENTS.md); the design is in [Architecture](architecture.md).

## Checks and tests

```bash
npm run check              # type check, lint and format check
npm run format             # format JavaScript, CSS, HTML, JSON and YAML
npm test                   # unit, HTTP and integration tests
npm run test:integration   # only the integration tests; already part of npm test
```

`npm run check` runs `tsc` over the JSDoc types, ESLint, stylelint and a Prettier check. When it reports formatting, run `npm run format`. Prettier does not format Markdown.

`npm test` runs `npm ci` first when the installed packages are not the ones of `package-lock.json`, so it works in a fresh clone or Git worktree, and after a merge that changed the dependencies. The service does not install anything: it refuses to start, and to restart, until you run `npm ci` (see [Installed packages](architecture.md#running-under-launchd)).

The integration tests (`tests/*.integration.mjs`) run against a real Ergo chat server. Each test starts its own temporary container from the image in `compose.yaml`, on a port that Docker picks, and removes it afterwards. The suite therefore needs a running Docker daemon, but not `npm run chat:up`, and it never touches the chat server of a running Mu. Without a Docker daemon the suite fails and says why.

One test starts a probe script with `python3`, so the tests need it on `PATH`.

The tests can run inside a Codex agent's sandbox. There, the tests that start a Seatbelt sandbox and those that need Docker are skipped with the reason, because macOS cannot start a sandbox inside another and the sandbox cannot reach Docker.

The browser check cannot run there: Chrome aborts at launch, because Codex allows a fixed set of system services and Chrome needs others, such as LaunchServices and the window server, and asking Codex to run the command outside the sandbox does not help ([why](harnesses.md#escalation-outside-the-sandbox)). The check fails and says so instead of being skipped, because a skip would pass the check that the pre-commit hook exists for. Run `npm run test:browser`, and commit changes that touch what it covers, from a Claude agent or your own shell.

The `demo` adapter exercises routing and process handling without a model; see [The demo adapter](harnesses.md#the-demo-adapter). Runs with real models also depend on each CLI's account, configuration, permissions and version.

### The visual frame in a real browser

JSDOM cannot show what protects the dashboard from a [visual](visuals.md): the frame's sandbox, the content security policies and module loading from an opaque origin. Nor can it select rendered text or paint a highlight, which comments depend on. The browser check does. It starts a throwaway Mu app with a fake chat and a second server that stands for another host, drives headless Google Chrome, and asserts that the frame draws diagrams and code, has no credential, storage or network, runs no handler from hostile content, sends no request to the other server, and cannot navigate away. A second test comments on selected text, on a diagram and on code, sends the comments, and lets the author answer them. A third answers the questions of a form whose labels are hostile, checks that the dashboard drops what no control can answer, and sends the answers from the dashboard's list. A fourth starts a turn of the author on sent comments and checks the light on the text, the block, the section and the whole visual, that it follows the layout and goes out with the turn or with the new version, the still tint under reduced motion, and the version buttons by keyboard. A fifth plays an animated explainer whose labels and captions are hostile: the message that travels, Play and Pause, a step back, a jump to a step, the dimmed parts of a focus, and the result of a step at once under reduced motion. A sixth leaves the visuals alone and types into the message box: the mention list that `@` opens, the keys that move, pick and close it, Enter that still sends when no list is open, and the mouse that picks without taking the focus from the text:

```bash
npm run test:browser
```

A second check, `tests/browser/lead-shortcut.browser.mjs`, presses the shortcut to the lead's chat from the workspace, a text field, another chat, the visual's frame and a dialog with a form, and types a message; it cannot tell whether a browser gives the page the key before its address bar, because headless Chrome has none and a key sent over the protocol skips the browser's own shortcuts. The helpers that these checks use are in `tests/browser/support.mjs`. `CHROME` names another browser binary. With `SHOTS` set to a directory, the check saves screenshots of each step there. It is not part of `npm test`, which must not need a browser. The pre-commit hook runs it when a commit changes what it covers: `public/visual/`, `public/visuals-view.js`, `public/visual-comments.js`, `public/visual-answers.js`, `public/visual-delivery.js`, `public/app.js`, `public/styles.css`, `src/visual-format.mjs`, `src/visual-patch.mjs`, `src/visual-scene.mjs`, `src/visual-spec.mjs`, `src/browser-policy.mjs` (the policies and the list of files the frame may load), `tests/browser/` or `package-lock.json`. Such a commit therefore needs Google Chrome. The dashboard's script and styles are on the list because the checks of the shortcut and of the drag depend on the layout and the handlers they hold. The fourth test also reads the look of the version buttons from `public/index.html`, which does not start the check; a change there that breaks the test shows in the next commit that starts it.

A third check, `tests/browser/focus-drag.browser.mjs`, drags cards of the focus list with the browser's own drag (Chrome hands it over through the protocol, and the test replays it as drag events at chosen points) and drops them under a short lane's cards, on its bottom edge and on the other lane's header, over a column that is not the first. JSDOM has no layout, so only a real browser shows which part of a lane box receives a drop. The pre-commit hook runs it with the others.

A check of the pages, `tests/browser/pages-layout.browser.mjs`, opens the overview, the Brag doc, Model evals and Visuals in a wide and a narrow window and measures what JSDOM cannot: each page fills the content area, no element inside it scrolls by itself (the window's scrollbar belongs at the window's edge), the header fits the window from 1500 down to 360 px with its controls in view, the work samples are framed with the panels' border, and the visual cards flow in the columns of the task cards, with the task link inside the card. It runs with the others.

A fourth check, `tests/browser/unread-persist.browser.mjs`, covers the unread markers with what JSDOM only fakes: a real reload, the `storage` event between two tabs of one browser, and storage that is kept apart for two Mu instances on different ports. It runs with the others. A fifth, `tests/browser/mention-badges.browser.mjs`, covers the mention badges: where the two badges sit on the chat icon, the popover list that the mention badge opens, opening a mention from it, and the counts across a reload.

A fifth check, `tests/browser/visual-author-wake.browser.mjs`, retires the worker that wrote a visual, then comments on it: the note that the author is stopped before anything is typed, the author that the send wakes, the section that its answer changes and flashes, and the note about a failed author, whose comment goes to the lead. It runs with the others.

## Git hooks

`npm ci` (or `npm install`) sets `core.hooksPath` to the tracked `.githooks` directory. The `pre-commit` hook runs `npm run check` and then `npm test`, which takes about fifteen seconds and needs a running Docker daemon. For a commit that changes the visual frame or the mention list of the message box it also runs [the browser check](#the-visual-frame-in-a-real-browser). The setting is in the repository's shared configuration, so it applies to every worktree. `npm ci` writes it only when it is not already `.githooks`, so it also works where Git configuration is read-only, as in a Codex agent's turn.

## Add a dashboard theme

Themes live in the `themes` registry in `public/themes.js`. Each theme has a stable `id`, a display `name`, and a complete `tokens` object: the colors, type, radii, shadows, spacing and motion that the dashboard's CSS uses.

1. Copy the `original` theme and change the tokens that express your design. Keep all color values in this file: the component CSS reads only tokens, SVG icons take the text color, and animations read the same motion tokens as the CSS.
2. The reading-settings panel lists every registry entry in a native radio group. It builds each swatch and accessible name from the theme, so adding one needs no HTML, server setting or build step.
3. Run `npm run check` and `npm test`. The theme tests check that the token set is complete, that references resolve, that the settings persist and work with the keyboard, and that text, controls, status badges and transcript output have enough contrast.
4. Look at the workspace, the chat, the dialogs and reading settings in a narrow and a wide window. Tests cannot judge the design. Keep labels and icons next to status colors, so that status does not depend on color alone.

**Mu original** keeps the original appearance, including message numbers at a contrast of 3.75:1. That is a known exception: the other themes meet WCAG AA.

### How the added themes were designed

Tidal Ledger, Citron Observatory and Ember Terminal were each derived from a ten-digit number, a *seed*. Each digit, counted from the left, sets one design parameter; the layout and icon shapes are the same in all themes.

| Digit | Sets |
| --- | --- |
| 1 | The base: `2` is light paper at hue 42°, `3` a dark blue at 222°, `7` a dark warm surface at 22°. Even digits give light surfaces. |
| 2 | The accent hue: digit × 36°. It also gives the first word of the name: `5` Tidal, `2` Citron, `0` Ember. |
| 3 | The color intensity (chroma): 0.35 + digit × 0.03. It also gives the second word: `3` Ledger, `0` Observatory, `2` Terminal. It tunes the status colors too: blue for idle, green for working, amber for blocked, violet for done, grey for stopped, rose for error. |
| 4 | The typeface: digit modulo 3, where 0 is sans-serif, 1 monospace and 2 serif. The type size scales by 1 + (digit − 5) × 0.005. |
| 5 | Corner rounding: 0–3 give 0.2 times the base radii, 4–6 give 1.25 times, 7–9 give 2.5 times. The favicon's radius is digit × 2. |
| 6 | Font weight: increased by digit × 5, at most 800. |
| 7 | A second hue: the accent + 90° + digit × 9°. |
| 8 | Spacing: a grid of 24 + digit × 2 px; spacing accents scale by 0.9 + digit × 0.02. |
| 9 | Animation speed: durations scale by 0.5 + digit × 0.1. |
| 10 | Shadow depth: an offset of digit px with three times that blur; the glow of a working agent uses the same depth. |

The seeds:

- `2533678612` is **Tidal Ledger**: pale paper, cyan ink, sans-serif type, soft corners, a 36 px grid, quick motion and shallow shadows.
- `3205321552` is **Citron Observatory**: midnight blue with citron and teal accents, serif type, square corners and measured motion.
- `7024703569` is **Ember Terminal**: dark warm surfaces with ember and green accents, monospace type, round corners and deep shadows.

Each theme has separate color roles for text, inverse text, surfaces, fills, edges and translucent accents, and the luminance of each role is constrained so that the generated colors stay legible.
