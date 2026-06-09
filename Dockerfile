# ─── Stage 1: Build ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace root files needed for install
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/api/package.json ./packages/api/

# Install all workspace dependencies (needed for inter-package linking)
RUN npm ci --workspace=packages/shared --workspace=packages/api --include-workspace-root

# Copy shared package source (dependency of api)
COPY packages/shared/ ./packages/shared/

# Copy api package source
COPY packages/api/ ./packages/api/

# Build the API package into a standalone bundle with esbuild
RUN npm run build --workspace=@alsaqi/api

# ─── Stage 2: Production ────────────────────────────────────────────────────
FROM node:20-slim AS production

WORKDIR /app

# Install only production dependencies needed at runtime
# Since esbuild bundles with --packages=external, we need node_modules
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/api/package.json ./packages/api/

RUN npm ci --workspace=packages/shared --workspace=packages/api --include-workspace-root --omit=dev

# Copy the bundled output from the build stage
COPY --from=builder /app/packages/api/dist/server.js ./packages/api/dist/server.js

# Create uploads directory
RUN mkdir -p /app/uploads

# Set environment defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV UPLOAD_DIR=/app/uploads

# Expose the API port
EXPOSE 3000

# Health check: curl the health endpoint and expect 200
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Run the bundled server
CMD ["node", "packages/api/dist/server.js"]
