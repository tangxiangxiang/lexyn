ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS production
ENV NODE_ENV=production LEXYN_HOST=0.0.0.0 LEXYN_PORT=3000 \
    LEXYN_DATA_DIR=/var/lib/lexyn LEXYN_BACKUP_DIR=/var/lib/lexyn/backups
WORKDIR /app
RUN install -d -m 0700 -o node -g node /var/lib/lexyn
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.LEXYN_PORT||3000)+'/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>{process.exitCode=1})"]
CMD ["node", "dist-server/server/index.js"]
