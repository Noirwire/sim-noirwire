# syntax=docker/dockerfile:1

# Build: all dependencies, compile TypeScript to dist/.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# The order book client is a release file kept in vendor/.
COPY vendor ./vendor
# No install scripts: nothing this service needs is built at install time,
# and a dependency's script is code that would run with the build's access.
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Production dependencies only.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Run: the compiled code and its production dependencies, as a user that
# owns nothing in the image.
FROM node:24-alpine AS run
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /app/data && chown -R node:node /app/data
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4100) + '/v1/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# Node itself as PID 1 would ignore SIGTERM's default; the application
# installs its own handlers, so a stop lets requests in flight finish.
CMD ["node", "dist/main.js"]
