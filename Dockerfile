# ─── Stage 1: Build ─────────────────────────────────────────────────────────
# Base images are pinned to an immutable content digest for reproducible,
# tamper-resistant builds (Requirement 20.1). The human-readable tag is kept in
# a trailing comment. Update both the digest and the comment together when bumping.
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder  # node:20-alpine

WORKDIR /app

# Copy workspace root files needed for install
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/

# Install all workspace dependencies (needed for inter-package linking)
RUN npm ci --include-workspace-root

# Copy shared package source (dependency of root app)
COPY packages/shared/ ./packages/shared/

# Copy application source
COPY src/ ./src/
COPY tsconfig.json ./

# Build the application using esbuild (bundles src/main.ts → dist/server.js)
RUN npm run build

# ─── Stage 2: Production ────────────────────────────────────────────────────
# Pin to specific minor version for reproducible builds. Update periodically.
# Pinned to an immutable content digest (Requirement 20.1); tag kept in comment.
FROM node:20.19-slim@sha256:b342de02eb4a57cd6986290a69833d20818508db8078dba0197a024193410aee AS production  # node:20.19-slim

WORKDIR /app

# Install the system Chromium browser plus the shared libraries required by
# Puppeteer. We rely on the distro Chromium (reachable at /usr/bin/chromium by
# any user, including the non-root runtime UID 1001) instead of Puppeteer's
# downloaded build, since PUPPETEER_SKIP_DOWNLOAD=true means no browser is
# fetched into root's cache (Finding 1.23 → 2.23).
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    wget \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# Install only production dependencies needed at runtime
# Since esbuild bundles with --packages=external, we need node_modules
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/

# Skip Puppeteer's bundled Chromium download — we use the system Chromium
# installed above (see PUPPETEER_EXECUTABLE_PATH below).
ENV PUPPETEER_SKIP_DOWNLOAD=true

RUN npm ci --include-workspace-root --omit=dev

# Copy the bundled output from the build stage
COPY --from=builder /app/dist/server.js ./dist/server.js

# Create uploads directory and data directory
RUN mkdir -p /app/uploads /app/data

# Create non-root user (UID 1001) and set permissions
RUN groupadd -g 1001 appuser && \
    useradd -u 1001 -g appuser -s /bin/sh -M appuser && \
    chown -R appuser:appuser /app && \
    chmod -R 755 /app && \
    chmod -R 770 /app/uploads

# Set environment defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV UPLOAD_DIR=/app/uploads
# Use the system Chromium (installed above) rather than a Puppeteer-downloaded
# build. PUPPETEER_SKIP_DOWNLOAD avoids fetching a browser at install time, and
# PUPPETEER_EXECUTABLE_PATH points Puppeteer at the reachable binary so in-container
# PDF generation works under the non-root runtime user (Finding 1.23 → 2.23).
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Expose the API port
EXPOSE 3000

# Health check: curl the health endpoint and expect 200
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Switch to non-root user
USER appuser

# Run the bundled server
CMD ["node", "dist/server.js"]
