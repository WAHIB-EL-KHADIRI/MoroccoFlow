FROM node:22.19.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
RUN npm ci --omit=dev --workspace @moroccoflow/api --include-workspace-root=false \
    && npm cache clean --force

FROM node:22.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=dependencies --chown=node:node /app/backend/node_modules ./backend/node_modules
COPY --chown=node:node backend ./backend
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "backend/src/server.js"]
