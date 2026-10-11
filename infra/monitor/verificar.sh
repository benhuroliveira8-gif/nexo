#!/bin/sh
# Monitor do Nexo (roda pelo Jenkins a cada 5 minutos).
#
# Confere: containers ligados e saudáveis, o app respondendo (com o banco),
# espaço em disco e se o backup diário está em dia. Se um container caiu,
# tenta religar. Quando algo muda (problema novo ou tudo voltou ao normal),
# avisa no canal #avisos do Nexo usando o bot (BOT_TOKEN do .env).
set -u

ESTADO_ARQ="${MONITOR_ESTADO:-.monitor-estado}"   # fica no workspace do Jenkins
DISCO_LIMITE="${MONITOR_DISCO_LIMITE:-90}"       # % de uso do disco
BACKUP_HORAS="${MONITOR_BACKUP_HORAS:-30}"       # backup mais velho que isso = problema

problemas=""
consertos=""
add() { problemas="${problemas}• $1
"; }
fix() { consertos="${consertos}• $1
"; }

servicos="db app caddy livekit"
case "${COMPOSE_FILE:-}$(grep -s '^COMPOSE_FILE=' .env)" in
  *publico*) servicos="$servicos cloudflared" ;;
esac

estado_servico() {
  id="$(docker compose ps -q "$1" 2>/dev/null)"
  [ -n "$id" ] || { echo "parado"; return; }
  docker inspect -f '{{if not .State.Running}}parado{{else if .State.Health}}{{.State.Health.Status}}{{else}}ok{{end}}' "$id" 2>/dev/null || echo "parado"
}

# 1) Containers
for s in $servicos; do
  st="$(estado_servico "$s")"
  if [ "$st" = "parado" ]; then
    echo "!! $s está parado; tentando religar..."
    docker compose up -d "$s" >/dev/null 2>&1
    sleep "${MONITOR_ESPERA:-20}"
    st="$(estado_servico "$s")"
    if [ "$st" = "parado" ]; then add "O serviço *$s* está parado e não voltou sozinho."
    else fix "O serviço *$s* tinha parado e foi religado."; fi
  elif [ "$st" = "unhealthy" ]; then
    add "O serviço *$s* está com problema (unhealthy)."
  fi
  echo "   $s: $st"
done

# 2) App respondendo (o /health também testa o banco)
saude="$(docker compose exec -T app wget -qO- http://localhost:3000/health 2>/dev/null)"
case "$saude" in
  *'"ok":true'*) echo "   app /health: ok" ;;
  *) add "O Nexo não está respondendo (/health falhou)." ;;
esac

# 3) Disco
uso="$(df -P / | awk 'NR==2 { gsub("%", "", $5); print $5 }')"
echo "   disco: ${uso}%"
if [ "${uso:-0}" -ge "$DISCO_LIMITE" ]; then
  add "O disco da VM passou de ${DISCO_LIMITE}% de uso (agora: ${uso}%). Libere espaço (ex.: docker system prune)."
fi

# 4) Backup em dia
horas="$(docker compose --profile backup run --rm -T backup idade 2>/dev/null | tail -n 1 | tr -dc '0-9-')"
echo "   último backup: há ${horas:-?} h"
if [ "${horas:--1}" = "-1" ]; then
  add "Não encontrei nenhum backup completo."
elif [ "$horas" -ge "$BACKUP_HORAS" ]; then
  add "O backup diário está atrasado: mais de ${BACKUP_HORAS} horas sem backup novo (veja o job nexo-backup)."

fi

# Avisa só quando muda (não manda a mesma coisa a cada 5 minutos).
# O número exato do disco não entra na comparação (senão avisaria a cada 1% a mais).
anterior="$(cat "$ESTADO_ARQ" 2>/dev/null || true)"
atual="$(printf '%s' "$problemas" | sed 's/(agora: [0-9]*%)//')"
printf '%s' "$atual" > "$ESTADO_ARQ"

mensagem=""
if [ -n "$problemas" ] && [ "$atual" != "$anterior" ]; then
  mensagem="🚨 **Monitor do Nexo** encontrou problemas:
${problemas}${consertos}"
elif [ -z "$problemas" ] && [ -n "$anterior" ]; then
  mensagem="✅ **Monitor do Nexo**: tudo voltou ao normal.
${consertos}"
elif [ -n "$consertos" ]; then
  mensagem="🔧 **Monitor do Nexo** consertou sozinho:
${consertos}"
fi

if [ -n "$mensagem" ]; then
  echo "$mensagem"
  if grep -qs '^BOT_TOKEN=nexo\.' .env; then
    # O token vai por variável de ambiente (não aparece na linha de comando nem no log).
    BOT_TOKEN="$(grep '^BOT_TOKEN=' .env | head -n 1 | cut -d= -f2- | tr -d '\r\"')" AVISO="$mensagem" \
      docker compose exec -T -e BOT_TOKEN -e AVISO app node - < "$(dirname "$0")/avisar.js" || echo "(não deu para avisar pelo Nexo)"
  else
    echo "(sem BOT_TOKEN no .env: aviso só aparece aqui no Jenkins)"
  fi
fi

if [ -n "$problemas" ]; then
  printf 'PROBLEMAS:\n%s' "$problemas"
  exit 1
fi
echo "Tudo certo."
