FROM node:24-bookworm-slim
ARG CLAUDE_VERSION
ARG CODEX_VERSION
ARG PI_VERSION
RUN test -n "$CLAUDE_VERSION" && test -n "$CODEX_VERSION" && test -n "$PI_VERSION" && npm install -g "@anthropic-ai/claude-code@$CLAUDE_VERSION" "@openai/codex@$CODEX_VERSION" "@earendil-works/pi-coding-agent@$PI_VERSION" && npm cache clean --force
COPY src/eval-driver.mjs src/adapters.mjs src/sandbox.mjs src/paths.mjs src/codex-rollout.mjs src/files.mjs /opt/mu/
USER node
ENV HOME=/tmp/home PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ENTRYPOINT ["node", "/opt/mu/eval-driver.mjs"]
