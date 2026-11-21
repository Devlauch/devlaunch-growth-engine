FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* pnpm-lock.yaml* ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/agent-sdk/package.json ./packages/agent-sdk/package.json
COPY packages/db/package.json ./packages/db/package.json
RUN npm install --workspaces --include-workspace-root

FROM deps AS build
COPY . .
RUN npm run build --workspace=@devlaunch/agent-sdk
RUN npm run build --workspace=@devlaunch/worker

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/agent-sdk ./packages/agent-sdk
COPY --from=build /app/apps/worker ./apps/worker
WORKDIR /app/apps/worker
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD node -e "process.exit(0)"
CMD ["node", "dist/index.js"]
