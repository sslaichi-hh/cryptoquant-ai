FROM node:24-alpine

WORKDIR /app

# Install dependencies (includes devDeps for tsx runtime)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source code
COPY . .

# Build frontend (vite -> dist/)
RUN npm run build

# Create data directory for SQLite
RUN mkdir -p data

# Production environment
ENV NODE_ENV=production
EXPOSE 3000

# Start server in production mode
CMD ["node", "scripts/run-server.mjs", "production"]
