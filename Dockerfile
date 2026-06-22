FROM node:24-alpine

WORKDIR /app

# Install dependencies (includes devDeps for tsx runtime)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source code
COPY . .

# Build frontend (vite -> dist/)
RUN npm run build

# Production environment
ENV NODE_ENV=production
EXPOSE 3000

# Create data dir at runtime (Render may run as non-root user)
# Start server in production mode
CMD ["sh", "-c", "mkdir -p /app/data && exec node scripts/run-server.mjs production"]
