#!/bin/sh
set -e
cd /app/server

# Cópia de segurança ANTES de mexer no schema: `prisma db push --accept-data-loss`
# pode apagar coluna/tabela sem aviso. Guarda os 10 últimos em <pasta do banco>/backups.
DB_FILE=$(printf '%s' "${DATABASE_URL:-}" | sed -e 's#^file:##' -e 's#?.*$##')
if [ -n "$DB_FILE" ] && [ -f "$DB_FILE" ]; then
  BK_DIR="$(dirname "$DB_FILE")/backups"
  mkdir -p "$BK_DIR"
  BK_FILE="$BK_DIR/pre-deploy-$(date +%Y-%m-%d-%H-%M).db"
  echo "→ Backup pré-deploy em $BK_FILE…"
  if sqlite3 "$DB_FILE" ".backup '$BK_FILE'"; then
    ls -1t "$BK_DIR"/pre-deploy-*.db 2>/dev/null | tail -n +11 | xargs -r rm -f
  else
    echo "!! Backup pré-deploy falhou (seguindo mesmo assim)"
    rm -f "$BK_FILE"
  fi
fi

echo "→ Aplicando schema no banco (prisma db push)…"
npx prisma db push --skip-generate --accept-data-loss
echo "→ Iniciando AtendeHub…"
exec npx tsx src/index.ts
