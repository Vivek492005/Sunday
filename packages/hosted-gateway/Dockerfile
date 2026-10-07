# Sunday hosted gateway — production image.
# Build from the repo root: docker build -f packages/hosted-gateway/Dockerfile .
FROM node:24-alpine AS build
WORKDIR /app
# pnpm workspace: copy ALL manifests first for layer caching.
# (--frozen-lockfile needs every workspace package.json to match the lockfile.)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/browserd/package.json packages/browserd/
COPY packages/context/package.json packages/context/
COPY packages/eval/package.json packages/eval/
COPY packages/ext-agent/package.json packages/ext-agent/
COPY packages/gateway/package.json packages/gateway/
COPY packages/hosted-gateway/package.json packages/hosted-gateway/
COPY packages/mcp/package.json packages/mcp/
COPY packages/orchestrator/package.json packages/orchestrator/
COPY packages/protocol/package.json packages/protocol/
COPY packages/skills/package.json packages/skills/
COPY packages/sunday-cli/package.json packages/sunday-cli/
COPY packages/sundayd/package.json packages/sundayd/
COPY packages/tools/package.json packages/tools/
COPY packages/ui-chat/package.json packages/ui-chat/
COPY packages/ui-manager/package.json packages/ui-manager/
RUN corepack enable && pnpm install --frozen-lockfile --filter @sunday/hosted-gateway...
# Copy sources and build
COPY packages/protocol packages/protocol
COPY packages/gateway packages/gateway
COPY packages/hosted-gateway packages/hosted-gateway
RUN pnpm --filter @sunday/hosted-gateway... build && \
    pnpm deploy --filter @sunday/hosted-gateway --prod /deploy

FROM node:24-alpine AS runtime
WORKDIR /app
COPY --from=build /deploy ./
ENV NODE_ENV=production
ENV SUNDAY_HOSTED_HOST=0.0.0.0
# Do NOT pin SUNDAY_HOSTED_PORT here: config prefers it over PORT, and
# Render/Railway inject PORT dynamically. Default 8080 comes from config.ts.
EXPOSE 8080
# The operator provides: OPENROUTER_API_KEY and/or GROQ_API_KEY,
# plus SUNDAY_HOSTED_SOCIAL_AUTH=1 for the zero-config free tier.
CMD ["node", "dist/cli.js"]
