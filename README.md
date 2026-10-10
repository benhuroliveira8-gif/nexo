# Nexo

Chat em tempo real no estilo de servidores e canais. Projeto pessoal, construído em fases.

## O que já funciona

**Fase 1**
- Cadastro e login
- Servidores e canais de texto
- Mensagens em tempo real com histórico (carrega mais ao rolar para cima)
- Membros online/offline e "fulano está digitando…"

**Fase 2**
- **Cargos e permissões**: @everyone + cargos com cor, hierarquia (quem está acima manda em quem está abaixo) e 11 permissões (administrador, gerenciar servidor/cargos/canais/mensagens, expulsar, convidar, enviar, anexar, reagir, @everyone)
- **Configurações do servidor**: renomear, novo convite, apagar servidor, editar cargos e dar cargos a membros
- **Convites por link**: `http://servidor:3000/convite/CODIGO` (funciona até para quem ainda não tem conta)
- **Anexos**: imagens, vídeos, áudios e arquivos (até 8 MB, até 5 por mensagem), com botão, colar (Ctrl+V) e arrastar
- **Reações** com emojis e **seletor de emojis** na caixa de mensagem
- **Editar** (✏️ ou seta ↑) e **apagar** mensagens (Shift+clique apaga sem perguntar)
- **Menções** `@usuario` e `@everyone`, com autocompletar e destaque
- **Não lidas e notificações**: bolinhas e contadores nos canais, servidores e na aba do navegador; som ao ser mencionado
- **Amigos**: pedidos, aceitar/recusar, lista online
- **Mensagens diretas (DMs)** entre amigos ou pessoas do mesmo servidor
- Expulsar membros, sair do servidor, perfil com cargos ao clicar no nome

## Como rodar (no servidor Ubuntu com Docker)

```bash
cd ~/nexo
cp .env.example .env
nano .env          # troque DB_PASSWORD e JWT_SECRET (use: openssl rand -hex 32)
docker compose up -d --build
```

Abra `http://IP-DO-SERVIDOR:3000` no navegador.

O banco é atualizado sozinho ao iniciar (pasta `app/src/migrations`), sem perder dados.

Comandos úteis:

```bash
docker compose ps              # ver se está rodando
docker compose logs -f app     # ver os logs do app
docker compose up -d --build   # atualizar depois de mudar o código
docker compose down            # parar (os dados ficam salvos)
```

## Deploy automático (Jenkins)

O `Jenkinsfile` faz: baixar do GitHub → gerar a imagem → conferir a sintaxe → subir → testar o `/health`.
O Jenkins verifica o GitHub a cada ~2 minutos. Ele precisa de duas credenciais:
`github-nexo` (usuário + token do GitHub) e `nexo-env` (o arquivo `.env`, como "Secret file").

A imagem do Jenkins com Docker fica em `infra/jenkins/` (`bash infra/jenkins/recriar-jenkins.sh`).

## Estrutura

```
nexo/
├── docker-compose.yml       # app + banco Postgres + volume dos anexos
├── Jenkinsfile              # pipeline de deploy
├── infra/jenkins/           # imagem do Jenkins com acesso ao Docker
└── app/
    ├── src/
    │   ├── server.js        # inicia Express + Socket.IO
    │   ├── routes/          # API REST: auth, servers, messages, social (amigos/DMs)
    │   ├── realtime.js      # tempo real: enviar mensagem, digitando, lido, presença
    │   ├── messages.js      # criar/editar/apagar mensagens, menções, reações
    │   ├── permissions.js   # permissões e hierarquia de cargos
    │   ├── files.js         # upload/download de anexos e faxina
    │   ├── events.js        # avisos em tempo real para os navegadores
    │   ├── migrations/      # mudanças no banco, em ordem
    │   └── ...
    └── public/              # frontend (HTML, CSS e JS puro, sem build)
        ├── index.html
        ├── styles.css
        └── js/              # main.js, home.js (amigos), settings.js, emoji.js, state.js, util.js
```

## Segurança (bom saber)

- Senhas guardadas com bcrypt; login por token JWT (7 dias).
- Todo texto de usuário entra na tela como texto, nunca como HTML.
- Anexos: só imagens/vídeos/áudios abrem no navegador; o resto (HTML, SVG, etc.) sempre vira download.
  O link de um anexo é um código aleatório impossível de adivinhar, mas quem tiver o link consegue abrir
  (igual ao Discord).
- O Jenkins tem controle do Docker do servidor: use senha forte e não exponha o Jenkins na internet.

## Próxima fase

- **Fase 3:** canais de voz, vídeo e compartilhamento de tela (LiveKit), API para bots.
