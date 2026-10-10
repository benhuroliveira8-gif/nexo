# Nexo

Chat em tempo real no estilo de servidores e canais. Projeto pessoal, construído em fases.

**Fase 1 (atual):** cadastro e login, criar servidores, canais de texto, mensagens em tempo real com histórico, lista de membros online/offline, "digitando…" e entrada por código de convite.

## Como rodar (no servidor Ubuntu com Docker)

```bash
cd ~/nexo
cp .env.example .env
nano .env          # troque DB_PASSWORD e JWT_SECRET (use: openssl rand -hex 32)
docker compose up -d --build
```

Abra `http://IP-DO-SERVIDOR:3000` no navegador.

Comandos úteis:

```bash
docker compose ps              # ver se está rodando
docker compose logs -f app     # ver os logs do app
docker compose up -d --build   # atualizar depois de mudar o código
docker compose down            # parar (os dados ficam salvos)
```

## Estrutura

```
nexo/
├── docker-compose.yml     # app + banco Postgres
├── .env.example           # modelo das configurações
└── app/
    ├── Dockerfile
    ├── package.json
    ├── src/
    │   ├── server.js      # inicia Express + Socket.IO
    │   ├── routes.js      # API REST (/api/...)
    │   ├── realtime.js    # eventos em tempo real (mensagens, presença, digitando)
    │   ├── auth.js        # senhas (bcrypt) e tokens (JWT)
    │   ├── presence.js    # quem está online
    │   ├── db.js          # conexão com o Postgres
    │   ├── schema.sql     # tabelas (criadas automaticamente)
    │   └── serializers.js # formato JSON das respostas
    └── public/            # frontend (HTML, CSS e JS puro, sem build)
        ├── index.html
        ├── styles.css
        └── app.js
```

## API

| Método | Rota | O que faz |
|---|---|---|
| POST | `/api/auth/register` | Cria conta `{ username, displayName, password }` |
| POST | `/api/auth/login` | Login `{ username, password }` → `{ token, user }` |
| GET | `/api/me` | Usuário logado |
| GET | `/api/servers` | Meus servidores |
| POST | `/api/servers` | Cria servidor `{ name }` (já vem com `#geral`) |
| POST | `/api/servers/join` | Entra com convite `{ code }` |
| GET | `/api/servers/:id` | Canais e membros do servidor |
| POST | `/api/servers/:id/channels` | Cria canal `{ name }` (só o dono) |
| GET | `/api/channels/:id/messages?before=` | Histórico, 50 por vez |

Eventos Socket.IO: `message:send` (cliente → servidor), `message:new`, `channel:created`, `member:joined`, `presence`, `typing`.

## Próximas fases

- **Fase 2:** cargos e permissões, links de convite com validade, imagens e arquivos, emojis e reações, DMs e amigos, menções e notificações.
- **Fase 3:** canais de voz, vídeo e compartilhamento de tela (LiveKit), API para bots.
