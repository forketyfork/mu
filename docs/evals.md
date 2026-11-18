# Model evals

Use **Model evals** in the dashboard to ask “Is this model better at my work?” The three public examples cover CI diagnosis, a CLI options change tested with Node's real argument parser, and a merge that must preserve both branches' intent. These are short work samples, not a test of an agent's ability to operate an entire repository.

## Set up an isolated runner

Build the local image with the exact published CLI versions you want to compare. Substitute the version numbers for the three placeholders:

```sh
docker build -f scripts/eval-runner.Dockerfile \
  --build-arg CLAUDE_VERSION=<claude-version> \
  --build-arg CODEX_VERSION=<codex-version> \
  --build-arg PI_VERSION=<pi-version> -t mu-eval-runner:local .
```

Mu needs the Docker CLI and daemon on the service host. It uses an already-built image, never pulls one on a dashboard request, and pins its image ID for the run. Set `MU_EVAL_IMAGE` in the service environment to choose a different trusted image built with the same driver. Rebuild when changing a harness or the bundled driver. No image or provider credentials are needed to browse previous runs or preview a suite.

Give the service an evaluation key for the selected harness, named with `MU_EVAL_` before the variable that the CLI reads: `MU_EVAL_ANTHROPIC_API_KEY`, `MU_EVAL_ANTHROPIC_AUTH_TOKEN` or `MU_EVAL_CLAUDE_CODE_OAUTH_TOKEN` for Claude, and `MU_EVAL_CODEX_API_KEY` or `MU_EVAL_OPENAI_API_KEY` for Codex. For pi, `MU_EVAL_PI_<PROVIDER>_API_KEY` passes `<PROVIDER>_API_KEY`. Only these explicit values reach a container: a key or login that the service's environment holds for your own CLIs is never forwarded, and agent turns never get an `MU_EVAL_` variable. Claude and Codex also accept `MU_EVAL_ANTHROPIC_BASE_URL` and `MU_EVAL_OPENAI_BASE_URL` for a compatible gateway. The gateway must be reachable from the container, whose `localhost` is not the host machine; with Docker Desktop, a gateway that listens on the host's loopback is at `host.docker.internal`. A gateway that authenticates by its address still needs some key for the CLI to start; any placeholder works. Configure these variables for the service, not in a fixture. For launchd, see [what the agent records](launchd.md). Never bake credentials into an image.

For a custom pi model or gateway, set `MU_EVAL_PI_MODELS_JSON` to the contents of a trusted pi `models.json` provider catalog. Use environment-variable names in its key fields, not literal secrets. Mu writes it only to the disposable pi home. For a Codex gateway, the base URL must expose the Responses API; Mu selects that provider explicitly and passes the configured key by environment-variable name.

Each case starts a new container and session. No host directories, live Mu state, user CLI login files, MCP settings or checkouts are mounted. Only the selected harness's `MU_EVAL_` values are forwarded. The harness gets no tools: no shell, web search, sub-agents or file access. The container needs network access to the model provider: private prompts go to that provider. Prefer narrowly scoped evaluation credentials. Use an image you trust and only trusted private case definitions. This page does not run arbitrary judge scripts or code from replies.

## Run and compare

1. Enter the exact model ID your container's CLI accepts (for pi, `provider/model-id`). Choose harness, reasoning effort, cases and a budget in USD.
2. **Preview run** shows the amount, case count and estimated spend where matching history exists: the most recent known charge for each identical case, model, harness and effort. An estimate for only some cases is not an estimate for the whole suite. Preview does not contact the provider.
3. **Start paid run** starts cases in order, one at a time. The budget **stops before the next case**; it is not a billing ceiling. One Codex or pi case can exceed it. Claude also gets `--max-budget-usd` for the amount remaining. Unknown spend stops the run. A failed harness is shown separately from an incorrect answer. A stopped run is not resumed automatically.
4. Select two saved runs. Read both the score and the evidence behind a missed check. The overall score is the weighted mean of complete case fractions, not the fraction of all individual checks. Incomplete suites have no overall score. A changed fixture appears on a separate row; compare only like versions. Repeat close results; a single short run does not establish a model ranking. The harness image and any reported model ID help identify moving aliases.

Time includes harness startup; reported tokens may include cached tokens and are not necessarily equivalent across harnesses. Claude and pi report their own costs. Claude prices a model it does not know with a guess, so check its reported model. pi prices a model that its catalog lists without a cost at zero; Mu records that spend as **unknown**. Codex costs use per-call token counts from its disposable session and Mu's price catalog, not an invoice; a model missing from the cached catalog makes the first case's spend unknown, which stops the run. A harness stopped by the time limit has unknown spend too, since a call may have been in flight. Unknown spend is never counted as zero; the page keeps the subtotal of known charges separately. Runs persist in Mu's SQLite store, not in the browser.

## Add private work samples

Put a JSON file in `evals/` in the Mu home, **not** in the checkout. Select **Refresh** on the page; no service restart is required. Keep identifying names and operational logs out of public examples. Model a concrete decision, use contrasting cases that rule out a plausible wrong answer, and keep prompts short. A check with only a few possible answers, such as a boolean or a choice of three, passes by luck too often: put related small answers into one `equals` check on an object, so that a guess must get them all right. A case's score should still make sense when you inspect a bad reply.

Use the public `evals/` examples as templates. Give each case a unique `id`, `title`, `skill`, a self-contained `prompt` defining the requested JSON fields, and `checks`. Set optional `weight` greater than zero and at most 100; the default is 1. The model sees the prompt, not the checks. A malformed collection is reported; it does not hide saved history.

| Check | Contract |
|---|---|
| `equals` | The response `field` equals the JSON `value`; array order and scalar types matter. A missing field does not equal `null`. |
| `cli` | Use the options in `field` with strict Node `util.parseArgs` on `argv`; compare actual `values` to the expected object. No code is executed. |
| `cli-regression` | The proposed test (`argv` and expected `values` in `field`) must pass the `reference` parser and distinguish it from one that keeps only the last value of the named `lastOnly` repeatable option. |
| `brief` | Text in `field` must meet `maxWords`, contain every `require` word or phrase and none of the `forbid` ones, as whole words, ignoring case. This checks explicit constraints, **not** factual entailment or writing quality. |

Every check needs a reader-facing `label`. The response must be a JSON object: prose or fenced JSON receives zero credit. Personal files are not published, but public sample answer keys are public and may be memorized. Use fresh private variants to decide a close comparison.
