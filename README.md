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

**Fase 3**
- **Canais de voz** 🔊: microfone, mutar, ensurdecer e borda verde em quem está falando
- **Câmera** 📹 e **compartilhar tela** 🖥️ dentro dos canais de voz
- Dá para continuar na voz enquanto navega pelos canais de texto e DMs
- Novas permissões: *Entrar em canais de voz*, *Falar* e *Vídeo e tela*
- **API para bots** 🤖: contas de bot com token, envio pela API REST e eventos em tempo real
- **Bot de exemplo** pronto (`!ajuda`, `!ping`, `!dado`, `!eco`, `!uptime`)
- **HTTPS** com o Caddy (o navegador exige HTTPS para microfone e câmera)

## Como rodar (no servidor Ubuntu com Docker)

```bash
cd ~/nexo
cp .env.example .env
nano .env                      # troque DB_PASSWORD e JWT_SECRET (use: openssl rand -hex 32)
bash infra/completar-env.sh    # gera NEXO_HOST e as chaves do LiveKit
docker compose up -d --build
```

Abra **`https://IP-DO-SERVIDOR`** no navegador (o `http://IP:3000` continua funcionando, mas sem voz).

### Certificado HTTPS (rede local)

O Caddy cria o próprio certificado. Na primeira visita o navegador avisa "conexão não particular":
clique em **Avançado → Continuar**. Para o aviso sumir de vez, instale o certificado raiz no Windows:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ~/nexo-ca.crt
```

Baixe o `nexo-ca.crt` (VS Code: botão direito → Download), dê dois cliques nele →
**Instalar Certificado** → *Usuário Atual* → *Colocar todos os certificados no repositório a seguir* →
**Autoridades de Certificação Raiz Confiáveis** → Concluir. Feche e abra o navegador.

### Portas usadas

| Porta | Para quê |
|---|---|
| 443 / 80 | Nexo em HTTPS (Caddy) |
| 3000 | Nexo direto, sem HTTPS |
| 7881/tcp e 7882/udp | Áudio e vídeo (LiveKit) |
| 8080 | Jenkins |

O banco é atualizado sozinho ao iniciar (pasta `app/src/migrations`), sem perder dados.

Comandos úteis:

```bash
docker compose ps              # ver se está rodando
docker compose logs -f app     # ver os logs do app
docker compose up -d --build   # atualizar depois de mudar o código
docker compose down            # parar (os dados ficam salvos)
```

## Bots

1. No Nexo, clique no seu nome (embaixo, à esquerda) → **Desenvolvedor (bots)** → **Criar bot**. Copie o token.
2. Na mesma tela, **Adicionar a um servidor** (precisa da permissão *Gerenciar servidor*).
3. Para rodar o bot de exemplo, coloque no `.env` `BOT_TOKEN=<token>` e rode:

```bash
docker compose --profile bots up -d --build bot-exemplo
docker compose logs -f bot-exemplo
```

Para programar o seu: edite `examples/bot-exemplo/index.js` (cada comando é uma entrada em `COMMANDS`).

**API para bots** — sempre com o cabeçalho `Authorization: Bot <token>`:

| Método | Rota | O que faz |
|---|---|---|
| GET | `/api/me` | Dados do bot |
| GET | `/api/servers` | Servidores onde o bot está |
| GET | `/api/servers/:id` | Canais e membros |
| GET | `/api/channels/:id/messages` | Histórico |
| POST | `/api/channels/:id/messages` | Envia `{ content }` |
| PATCH/DELETE | `/api/messages/:id` | Edita/apaga as próprias mensagens |
| PUT/DELETE | `/api/messages/:id/reactions/:emoji` | Reage |

Tempo real: conecte no Socket.IO com `auth: { token: "Bot <token>" }` e escute `message:new`,
`message:updated`, `message:deleted`, `message:reactions`, `presence`.
Bots não podem criar servidores, entrar por convite, ter amigos ou entrar em canais de voz.
Limite: 5 mensagens a cada 5 segundos (acima disso a API responde 429).

## Deploy automático (Jenkins)

O `Jenkinsfile` faz: baixar do GitHub → gerar a imagem → conferir a sintaxe → subir → testar o `/health`.
O Jenkins verifica o GitHub a cada ~2 minutos. Ele precisa de duas credenciais:
`github-nexo` (usuário + token do GitHub) e `nexo-env` (o arquivo `.env`, como "Secret file").

A imagem do Jenkins com Docker fica em `infra/jenkins/` (`bash infra/jenkins/recriar-jenkins.sh`).

## Estrutura

```
nexo/
├── docker-compose.yml       # app, Postgres, Caddy (HTTPS), LiveKit (voz) e bot de exemplo
├── Jenkinsfile              # pipeline de deploy
├── infra/
│   ├── caddy/               # HTTPS na frente do app
│   ├── livekit/             # servidor de voz e vídeo
│   ├── jenkins/             # imagem do Jenkins com acesso ao Docker
│   └── completar-env.sh     # gera as configurações novas no .env
├── examples/bot-exemplo/    # bot pronto para usar e modificar
└── app/
    ├── src/
    │   ├── server.js        # inicia Express + Socket.IO
    │   ├── routes/          # API REST: auth, servers, messages, social (amigos/DMs)
    │   ├── realtime.js      # tempo real: enviar mensagem, digitando, lido, presença
    │   ├── messages.js      # criar/editar/apagar mensagens, menções, reações
    │   ├── permissions.js   # permissões e hierarquia de cargos
    │   ├── voice.js         # quem está na voz + tokens do LiveKit
    │   ├── files.js         # upload/download de anexos e faxina
    │   ├── events.js        # avisos em tempo real para os navegadores
    │   ├── migrations/      # mudanças no banco, em ordem
    │   └── ...
    └── public/              # frontend (HTML, CSS e JS puro, sem build)
        ├── index.html
        ├── styles.css
        └── js/              # main.js, voice.js, developer.js (bots), home.js (amigos), settings.js, ...
```

## Segurança (bom saber)

- Senhas guardadas com bcrypt; login por token JWT (7 dias).
- Todo texto de usuário entra na tela como texto, nunca como HTML.
- Anexos: só imagens/vídeos/áudios abrem no navegador; o resto (HTML, SVG, etc.) sempre vira download.
  O link de um anexo é um código aleatório impossível de adivinhar, mas quem tiver o link consegue abrir
  (igual ao Discord).
- O Jenkins tem controle do Docker do servidor: use senha forte e não exponha o Jenkins na internet.

## Limitações conhecidas

- A voz funciona na sua rede. Para amigos de fora, o servidor precisa ficar acessível pela internet
  (domínio + HTTPS de verdade + portas do LiveKit liberadas).
- Se alguém perder a permissão de voz enquanto já está num canal, só sai na próxima vez que entrar.
