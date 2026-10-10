#!/usr/bin/env bash
# Recria o container do Jenkins com acesso ao Docker do servidor.
# Os jobs, usuários e plugins NÃO se perdem: ficam no volume jenkins_home.
set -euo pipefail
cd "$(dirname "$0")"

echo ">> Construindo a imagem jenkins-docker..."
docker build -t jenkins-docker .

echo ">> Removendo o container antigo (os dados ficam no volume)..."
docker rm -f jenkins 2>/dev/null || true

DOCKER_GID="$(getent group docker | cut -d: -f3)"

echo ">> Subindo o Jenkins novo..."
docker run -d --name jenkins --restart unless-stopped \
  -p 8080:8080 -p 50000:50000 \
  -v jenkins_home:/var/jenkins_home \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$DOCKER_GID" \
  jenkins-docker

echo ">> Testando o acesso ao Docker de dentro do Jenkins..."
sleep 3
docker exec jenkins docker version --format 'OK: Jenkins enxerga o Docker {{.Server.Version}}'
