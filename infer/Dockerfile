FROM node:24-slim

WORKDIR /app/infer
COPY infer/package.json infer/package-lock.json ./
RUN npm ci --omit=dev

COPY infer/server.mjs infer/worker.mjs ./
COPY web/src/core /app/web/src/core
COPY web/public /app/web/public

ENV PORT=8300
USER node
EXPOSE 8300
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:8300/api/chat/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
