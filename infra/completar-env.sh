#!/usr/bin/env bash
# Acrescenta ao .env as configurações novas da Fase 3 (sem mexer no que já existe).
# Uso:  bash infra/completar-env.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "Não achei o arquivo .env na pasta $(pwd). Crie com: cp .env.example .env" >&2
  exit 1
fi

add() {
  if grep -q "^$1=" .env; then
    echo "   $1 já existe (mantido)"
  else
    printf '%s=%s\n' "$1" "$2" >> .env
    echo " + $1 adicionado"
  fi
}

# Garante que o arquivo termina com quebra de linha antes de acrescentar.
[ -n "$(tail -c1 .env)" ] && echo >> .env

# IP da placa que sai para a rede (ignora as redes internas do Docker).
IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' || true)"
[ -z "$IP" ] && IP="$(hostname -I | awk '{print $1}')"
echo ">> Completando o .env (IP detectado: $IP)"
add NEXO_HOST "$IP"
add LIVEKIT_API_KEY "nexo$(openssl rand -hex 4)"
add LIVEKIT_API_SECRET "$(openssl rand -hex 32)"
add MAX_UPLOAD_MB 8

echo
echo "Pronto. Lembre de atualizar a credencial 'nexo-env' no Jenkins com este .env novo."
