#!/usr/bin/env bash
# Monta o ambiente de demonstração (Estúdio Aurora) num projeto Supabase NOVO.
# Pré-requisito: supabase login (conta do Luis) OU SUPABASE_ACCESS_TOKEN no env.
# Uso: ./scripts/demo/montar-demo.sh <org-id> [db-password]
set -euo pipefail
cd "$(dirname "$0")/../.."

ORG="${1:?org-id obrigatorio (supabase orgs list)}"
DBPASS="${2:-Aurora$(date +%s)Demo!}"
NAME="plataforma-demo-aurora"

echo "== criando projeto $NAME na org $ORG (sa-east-1)..."
supabase projects create "$NAME" --org-id "$ORG" --db-password "$DBPASS" --region sa-east-1 -o json > /tmp/demo-project.json
REF=$(python3 -c "import json;print(json.load(open('/tmp/demo-project.json'))['id'])")
echo "   ref: $REF"

echo "== aguardando provisionar..."
until supabase projects api-keys --project-ref "$REF" -o json > /tmp/demo-keys.json 2>/dev/null; do sleep 5; done
ANON=$(python3 -c "import json;ks=json.load(open('/tmp/demo-keys.json'));print([k['api_key'] for k in ks if k['name']=='anon'][0])")
SERVICE=$(python3 -c "import json;ks=json.load(open('/tmp/demo-keys.json'));print([k['api_key'] for k in ks if k['name']=='service_role'][0])")
URL="https://$REF.supabase.co"

echo "== aplicando migracoes..."
supabase link --project-ref "$REF" -p "$DBPASS"
supabase db push -p "$DBPASS" --include-all

echo "== criando usuario demo..."
curl -s -X POST "$URL/auth/v1/admin/users" \
  -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE" -H "Content-Type: application/json" \
  -d '{"email":"demo@estudioaurora.com.br","password":"AuroraDemo2026!","email_confirm":true}' | head -c 200; echo

echo "== aplicando seed..."
PGURL="postgresql://postgres.$REF:$DBPASS@aws-0-sa-east-1.pooler.supabase.com:5432/postgres"
psql "$PGURL" -v ON_ERROR_STOP=1 -f scripts/demo/seed-estudio-aurora.sql

echo "== escrevendo .env.local..."
printf 'VITE_SUPABASE_URL=%s\nVITE_SUPABASE_ANON_KEY=%s\n' "$URL" "$ANON" > .env.local

echo
echo "PRONTO. Login: demo@estudioaurora.com.br / AuroraDemo2026!"
echo "Rode: npx vite --port 5199"
