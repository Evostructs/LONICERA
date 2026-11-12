FROM node:24-alpine
WORKDIR /app
ARG NPM_REGISTRY=
ENV NODE_ENV=production \
    SAVE_DIR=/app/data \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
COPY --chown=node:node package*.json ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
    && npm ci --omit=dev \
    && npm cache clean --force
COPY --chown=node:node . .
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data
EXPOSE 2026
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:2026/api/status || exit 1
USER node
CMD ["node", "server.js"]
