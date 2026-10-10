# A configuração vai dentro da imagem (e não como "volume"), porque o Jenkins
# roda o docker compose de dentro de um container e não enxerga as pastas do servidor.
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
