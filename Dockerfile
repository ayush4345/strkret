# syntax=docker/dockerfile:1.7
# Builds and serves the visitor-facing mainnet console (web/) out of this
# pnpm workspace. Everything else in the repo (contracts, the agent
# processes, the devnet demos) is dev/CI tooling and is not part of this
# image's runtime.

FROM node:24-slim AS base
RUN corepack enable
WORKDIR /repo

# ---- deps: install once, with the GitHub Packages token as a build secret
# so it never lands in an image layer or this file. ----
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/agent-core/package.json packages/agent-core/package.json
COPY packages/privacy-client/package.json packages/privacy-client/package.json
COPY agents/provider/package.json agents/provider/package.json
COPY agents/consumer/package.json agents/consumer/package.json
COPY web/package.json web/package.json
RUN --mount=type=secret,id=gh_packages_token \
    if [ -f /run/secrets/gh_packages_token ]; then \
      echo "@starkware-libs:registry=https://npm.pkg.github.com" > .npmrc && \
      echo "//npm.pkg.github.com/:_authToken=$(cat /run/secrets/gh_packages_token)" >> .npmrc; \
    fi && \
    pnpm install --frozen-lockfile && \
    rm -f .npmrc

# ---- build: agent-core and agent-provider first (web depends on both), then web ----
FROM deps AS build
COPY . .
RUN pnpm --filter @strkret/agent-core run build \
 && pnpm --filter @strkret/agent-provider run build \
 && pnpm --filter @strkret/web run build

# ---- runtime: only the standalone server + static assets ----
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/web/.next/standalone ./
COPY --from=build /repo/web/.next/static ./web/.next/static
EXPOSE 3100
ENV PORT=3100
CMD ["node", "web/server.js"]
