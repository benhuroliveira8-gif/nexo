#!/usr/bin/env bash
# Volta o Nexo para um backup. Rode na VM, dentro da pasta do projeto:
#
#   bash infra/backup/restaurar.sh            -> mostra os backups
#   bash infra/backup/restaurar.sh ultimo     -> restaura o mais novo
#   bash infra/backup/restaurar.sh 2026-10-10_0312
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] || { echo "Não achei o .env nesta pasta ($(pwd))." >&2; exit 1; }

run() { docker compose --profile backup run --rm --build backup "$@"; }

if [ $# -eq 0 ]; then
  run listar
  echo
  echo "Para restaurar: bash infra/backup/restaurar.sh <nome>   (ou: ultimo)"
  exit 0
fi

echo "ATENÇÃO: isso SUBSTITUI todas as mensagens, contas e anexos atuais pelo backup \"$1\"."
echo "(Antes, um backup do estado atual é feito, por segurança.)"
read -r -p "Digite SIM para continuar: " ok
[ "$ok" = "SIM" ] || { echo "Cancelado."; exit 1; }

echo ">> Backup de segurança do estado atual..."
run backup

echo ">> Parando o app..."
docker compose stop app
trap 'echo ">> Ligando o app de novo..."; docker compose start app' EXIT

run restaurar "$1"
