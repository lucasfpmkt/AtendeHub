# ---------- build ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm install
RUN cd server && npx prisma generate
RUN npm run --workspace client build

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV SERVE_CLIENT=1
# Mantém node_modules (inclui tsx e o CLI do Prisma usados no start).
COPY --from=build /app /app
EXPOSE 3001
CMD ["sh", "server/docker-entrypoint.sh"]
