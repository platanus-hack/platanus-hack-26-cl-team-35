FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/client/package.json packages/client/
COPY packages/core/package.json packages/core/
RUN npm ci
COPY seed seed
COPY scripts scripts
COPY assets assets
COPY packages/protocol packages/protocol
COPY packages/client packages/client
COPY packages/core packages/core
COPY packages/server packages/server
RUN npm run build
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/agentrooms.db
EXPOSE 8080
CMD ["node", "packages/server/src/index.ts"]
