#!/bin/sh
# Backup e restauração do Nexo (banco de dados + anexos/fotos).
#
#   nexo-backup                    faz um backup novo
#   nexo-backup listar             mostra os backups guardados
#   nexo-backup restaurar <nome>   volta tudo para um backup (ou "ultimo")
#   nexo-backup idade              horas desde o último backup completo
#
# Cada backup é uma pasta com a data, ex.: 2026-10-10_0300/
#   banco.dump      banco inteiro (formato do pg_dump)
#   anexos.tar.gz   arquivos enviados e fotos de perfil
#   OK              só existe se o backup terminou sem erro
set -eu

DEST="${BACKUP_DIR:-/backups}"
UPLOADS="${UPLOADS_DIR:-/uploads}"
KEEP_DAYS="${KEEP_DAYS:-14}"

say() { echo ">> $*"; }
die() { echo "ERRO: $*" >&2; exit 1; }

completos() {
  # Lista só os backups completos (com o arquivo OK), do mais antigo ao mais novo.
  for d in "$DEST"/20*; do
    [ -f "$d/OK" ] && basename "$d"
  done 2>/dev/null | sort
}

fazer_backup() {
  [ -d "$UPLOADS" ] || die "pasta de anexos $UPLOADS não encontrada"
  mkdir -p "$DEST"
  stamp="$(date +%Y-%m-%d_%H%M)"
  final="$DEST/$stamp"
  tmp="$DEST/.$stamp.tmp"
  [ -e "$final" ] && die "já existe um backup com o nome $stamp (espere 1 minuto)"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  # Se algo der errado no meio, não deixa lixo pela metade.
  trap 'rm -rf "$tmp"' EXIT

  say "Salvando o banco de dados..."
  pg_dump --format=custom --no-owner --file="$tmp/banco.dump"
  # Confere se o arquivo está legível antes de dar como certo.
  pg_restore --list "$tmp/banco.dump" >/dev/null

  say "Salvando anexos e fotos..."
  tar -czf "$tmp/anexos.tar.gz" -C "$UPLOADS" .
  tar -tzf "$tmp/anexos.tar.gz" >/dev/null

  date > "$tmp/OK"
  mv "$tmp" "$final"
  trap - EXIT
  say "Backup pronto: $final"
  du -sh "$final"/* | sed 's/^/   /'

  # Apaga backups com mais de KEEP_DAYS dias (o que acabou de ser feito nunca é apagado).
  antigos="$(find "$DEST" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime +"$KEEP_DAYS" ! -name "$stamp")"
  if [ -n "$antigos" ]; then
    say "Apagando backups com mais de $KEEP_DAYS dias:"
    echo "$antigos" | sed 's/^/   /'
    echo "$antigos" | xargs rm -rf
  fi
  # Restos de backups que foram interrompidos.
  find "$DEST" -mindepth 1 -maxdepth 1 -type d -name '.*.tmp' -mmin +120 -exec rm -rf {} + 2>/dev/null || true
  say "Backups guardados: $(completos | wc -l)"
}

listar() {
  lista="$(completos)"
  if [ -z "$lista" ]; then
    echo "Nenhum backup encontrado em $DEST."
    return 0
  fi
  echo "Backups em $DEST (o último é o mais novo):"
  for b in $lista; do
    echo "   $b   ($(du -sh "$DEST/$b" | cut -f1))"
  done
}

restaurar() {
  nome="${1:-}"
  [ -n "$nome" ] || { listar; die "diga qual backup restaurar (ex.: restaurar ultimo)"; }
  [ "$nome" = "ultimo" ] && nome="$(completos | tail -n 1)"
  [ -n "$nome" ] || die "não há backups para restaurar"
  case "$nome" in */*|.*) die "nome de backup inválido: $nome" ;; esac
  dir="$DEST/$nome"
  [ -f "$dir/OK" ] || die "backup $nome não existe ou está incompleto"

  say "Restaurando o banco a partir de $nome..."
  pg_restore --clean --if-exists --no-owner --single-transaction --exit-on-error \
    --dbname="${PGDATABASE:-nexo}" "$dir/banco.dump"

  say "Restaurando anexos e fotos..."
  mkdir -p "$UPLOADS"
  find "$UPLOADS" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  tar -xzf "$dir/anexos.tar.gz" -C "$UPLOADS"
  say "Pronto! Tudo voltou para $nome."
}

# Quantas horas faz desde o último backup completo (-1 = nenhum). Usado pelo monitor.
idade() {
  ultimo="$(completos | tail -n 1)"
  [ -n "$ultimo" ] || { echo -1; return 0; }
  agora="$(date +%s)"
  feito="$(stat -c %Y "$DEST/$ultimo/OK")"
  echo $(( (agora - feito) / 3600 ))
}

case "${1:-backup}" in
  backup) fazer_backup ;;
  listar) listar ;;
  idade) idade ;;
  restaurar) restaurar "${2:-}" ;;
  *) die "comando desconhecido: $1 (use: backup, listar ou restaurar <nome>)" ;;
esac
