# Stage 1: build Angular client
FROM node:22-slim AS client-builder
WORKDIR /build/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: build server
FROM node:22-slim AS server-builder
WORKDIR /build/server
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build:server

# Stage 3: production image
FROM node:22-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=server-builder /build/server/dist/ dist/
COPY --from=client-builder /build/client/dist/ client/dist/

EXPOSE 4173

CMD ["node", "dist/index.js"]
