# Dockerfile — DavTeam Ruflos AI Agents for Hugging Face Spaces
# Builds the real Ruflo runtime + DavTeam API + Osiri frontend.
# Provider credentials are injected via Hugging Face Secrets (env vars), never baked into the image.

FROM node:20-slim

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl bash python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json ./
COPY scripts ./scripts
COPY backend ./backend
COPY frontend ./frontend

# Install dependencies — real ruflo@3.45.0 plus backend deps.
# --omit=optional avoids heavy native optional deps (better-sqlite3, agentdb, ruvector)
# that Ruflo degrades gracefully without. --ignore-scripts avoids native compile OOM.
RUN npm install --omit=optional --ignore-scripts

# Verify the real Ruflo runtime is present
RUN node node_modules/ruflo/bin/ruflo.js --version

# Build the frontend (static assets, no compilation needed)
RUN node scripts/build-frontend.js

# Workspace for agent/tool execution
RUN mkdir -p /app/workspace
ENV WORKSPACE=/app/workspace

# Hugging Face Spaces uses port 7860 by default
ENV PORT=7860
ENV HOST=0.0.0.0
ENV NODE_ENV=production

EXPOSE 7860

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -fsS http://127.0.0.1:7860/health || exit 1

# Start the production API server (serves frontend + API)
CMD ["node", "backend/src/server.js"]
