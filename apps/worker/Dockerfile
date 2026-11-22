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
# apps/worker/src/jobs/sequenceSchedulerCron.ts dynamically imports
# apps/api/dist/lib/advanceSequences.js at runtime (there's no shared
# package for it — see that file's own doc comment) rather than
# reimplementing sequence-advance logic. That only ever worked in local
# dev, where both apps' dist/ directories sit on the same filesystem; in
# this image, apps/api was never built/copied at all, so the cron failed
# with ERR_MODULE_NOT_FOUND on every tick in any real container deployment,
# confirmed via Milestone 3 Phase 1 real-container testing.
RUN npm run build --workspace=@devlaunch/api

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/agent-sdk ./packages/agent-sdk
COPY --from=build /app/apps/worker ./apps/worker
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
WORKDIR /app/apps/worker
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD node -e "process.exit(0)"
CMD ["node", "dist/index.js"]
