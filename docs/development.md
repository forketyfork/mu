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

`npm test` runs `npm ci` first when `node_modules` is missing or older than `package-lock.json`, so it works in a fresh clone or Git worktree.

The integration tests (`tests/*.integration.mjs`) run against a real Ergo chat server. Each test starts its own temporary container from the image in `compose.yaml`, on a port that Docker picks, and removes it afterwards. The suite therefore needs a running Docker daemon, but not `npm run chat:up`, and it never touches the chat server of a running Mu. Without a Docker daemon the suite fails and says why.

One test starts a probe script with `python3`, so the tests need it on `PATH`.

The tests can run inside a Codex agent's sandbox. There, the tests that start a Seatbelt sandbox and those that need Docker are skipped with the reason, because macOS cannot start a sandbox inside another and the sandbox cannot reach Docker.

The `demo` adapter exercises routing and process handling without a model; see [The demo adapter](harnesses.md#the-demo-adapter). Runs with real models also depend on each CLI's account, configuration, permissions and version.

## Git hooks

`npm ci` (or `npm install`) sets `core.hooksPath` to the tracked `.githooks` directory. The `pre-commit` hook runs `npm run check` and then `npm test`, which takes about fifteen seconds and needs a running Docker daemon. The setting is in the repository's shared configuration, so it applies to every worktree. `npm ci` writes it only when it is not already `.githooks`, so it also works where Git configuration is read-only, as in a Codex agent's turn.

## Add a dashboard theme

Themes live in the `themes` registry in `public/themes.js`. Each theme has a stable `id`, a display `name`, and a complete `tokens` object: the colors, type, radii, shadows, spacing and motion that the dashboard's CSS uses.

1. Copy the `original` theme and change the tokens that express your design. Keep all color values in this file: the component CSS reads only tokens, SVG icons take the text color, and animations read the same motion tokens as the CSS.
2. The theme picker lists every registry entry by itself; no HTML, CSS, server setting or build step is needed.
3. Run `npm run check` and `npm test`. The theme tests check that the token set is complete, that references resolve, that the picker remembers the choice and works with the keyboard, and that text, controls, status badges and transcript output have enough contrast.
4. Look at the workspace, the chat, the dialogs and the picker in a narrow and a wide window. Tests cannot judge the design. Keep labels and icons next to status colors, so that status does not depend on color alone.

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
