# Marble tournament server — Node 22 (for the built-in node:sqlite) + a real
# headless Chromium (the server computes race results by running the actual
# game physics in a browser, so results match exactly what viewers replay).
FROM node:22-bookworm

# Playwright caches its browser here; set it before install so the download and
# the runtime lookup agree on one path.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Playwright is the app's only real runtime dependency (SQLite and the
# WebSocket server are hand-rolled / built in). Install it plus Chromium and all
# the system libraries Chromium needs, in one layer.
RUN npm install playwright@^1.49.0 \
  && npx playwright install --with-deps chromium \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*

# App source.
COPY . .

# Config (fly.toml can override). DB_PATH points at the mounted volume so
# standings survive restarts.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/data/tournament.db

EXPOSE 8080

CMD ["node", "src/server.js"]
