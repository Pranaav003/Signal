FROM node:20-slim

WORKDIR /app

# Install backend deps
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci --omit=dev

# Copy backend source
COPY backend/ ./

# Run migrations on startup, then start the server
CMD ["sh", "-c", "node src/db/migrate.js && node index.js"]
