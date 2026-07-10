# Telegram bot webhook server — tsx runtime (workspace packages ship raw TS;
# the NodeNext `dist` build question stays tech debt #9).
#
# Build from the REPO ROOT (pnpm monorepo context):
#   docker build -f apps/bot/Dockerfile .

FROM node:22-slim

WORKDIR /app

# pnpm via corepack, pinned by the "packageManager" field in package.json.
RUN corepack enable

# Production text interpreter. Pin exactly; auth is mounted at runtime and is
# never baked into the image.
RUN npm install --global @openai/codex@0.144.0
RUN codex --version | grep -F "codex-cli 0.144.0"

# Workspace manifests first so dependency layers cache across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/bot/package.json apps/bot/
COPY apps/web/package.json apps/web/
COPY packages/categorization/package.json packages/categorization/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/importers/package.json packages/importers/

# Only the bot and its workspace dependencies.
RUN pnpm install --frozen-lockfile --filter @family-finance/bot...

# Sources (raw TS — executed by tsx at runtime).
COPY packages packages
COPY apps/bot apps/bot

ENV NODE_ENV=production
ENV PORT=8787
ENV CODEX_HOME=/var/lib/family-finance-codex
RUN mkdir -p /var/lib/family-finance-codex && chown -R node:node /var/lib/family-finance-codex /app
USER node
EXPOSE 8787

CMD ["pnpm", "--filter", "@family-finance/bot", "start"]
