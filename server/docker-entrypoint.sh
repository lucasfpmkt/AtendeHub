#!/bin/sh
set -e
cd /app/server
echo "→ Aplicando schema no banco (prisma db push)…"
npx prisma db push --skip-generate --accept-data-loss
echo "→ Iniciando AtendeHub…"
exec npx tsx src/index.ts
