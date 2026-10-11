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

**Fase 4**
- **Responder mensagens** ↩️: a resposta mostra a mensagem original (clique para ir até ela) e avisa quem foi respondido
- **Threads** 🧵: conversa paralela a partir de uma mensagem; aparece embaixo do canal na barra lateral
- **Busca** 🔍: no servidor inteiro (canais e threads) ou nas DMs; `de:usuario` filtra por autor; clicar no resultado pula até a mensagem, mesmo antiga
- **Fixar mensagens** 📌: lista de fixadas no topo do canal (em servidor precisa de *Gerenciar mensagens*; em DM qualquer um fixa)
- **Status**: Online, Ausente, Não perturbe (sem sons) e Invisível, + **status personalizado** ("Jogando Minecraft")
- **Foto de perfil**: recortada e reduzida no navegador (256×256)
- **Backup diário** automático pelo Jenkins (banco + anexos), com restauração em um comando
- **Acesso pela internet** com domínio + túnel da Cloudflare ([docs/acesso-externo.md](docs/acesso-externo.md)) e código de cadastro opcional

**Fase 5**
- **App no celular/computador (PWA)** 📲: instale pelo navegador (Android/PC: "Instalar app"; iPhone: Compartilhar → "Adicionar à Tela de Início"). Abre em tela cheia, com ícone próprio
- **Notificações push** 🔔: avisam de mensagens diretas, menções, respostas e ligações mesmo com o Nexo fechado (precisa do endereço com HTTPS de verdade, ex.: o seu domínio; no iPhone, só com o app instalado). Ligue em ⚙️ → *Notificações e app*. As chaves são criadas sozinhas, sem mexer no `.env`
- **Formatação**: `**negrito**`, `*itálico*`, `__sublinhado__`, `~~riscado~~`, `` `código` ``, blocos ```` ``` ````, `> citação` e `||spoiler||` (atalhos Ctrl+B / Ctrl+I / Ctrl+U)
- **Prévias de link** 🔗: título, descrição e imagem dos sites; vídeos do YouTube tocam dentro do Nexo. Link entre `<sinais>` não ganha prévia. As imagens passam pelo servidor (os sites não veem o IP de quem lê) e endereços da rede local são bloqueados
- **Mensagens de voz** 🎤: segure o microfone para gravar e solte para enviar (um toque rápido grava com botões Cancelar/Enviar). Player com ondinha e velocidade 1×/1,5×/2×
- **Enquetes** 📊: botão ＋ → *Criar enquete* (até 10 opções, uma ou várias respostas, prazo de 1 hora a 1 semana)
- **Categorias** 📁 e **canais privados** 🔒 (só alguns cargos veem — as threads deles também)
- **Arrastar para reordenar** canais, categorias e cargos (no celular: segure e arraste)
- **Moderação**: **banir** (com opção de apagar mensagens recentes), **castigo** (só ler por 1 min a 1 semana) e **registro de auditoria**. Novas permissões: *Banir membros*, *Castigar membros* e *Ver registro de auditoria*
- **Convites com validade e limite de usos** (e lista de convites ativos para apagar)
- **Ícone do servidor** e **"Sobre mim"** no perfil
- **Chamadas de voz e vídeo nas DMs** 📞 (tocam no outro aparelho com Atender/Recusar) e **grupos de DM** (3 a 10 pessoas, com nome)
- **Volume de cada pessoa**, **aperte para falar** (com tecla escolhida e botão "segure para falar" no celular) e **supressão de ruído**
- **Segurança da conta**: trocar senha, **verificação em duas etapas** (app autenticador + códigos de recuperação), **sair de todos os aparelhos** e **apagar conta**
- **Tema claro** ☀️ e **cor de destaque** (⚙️ → *Aparência*)

**Extras**
- **Emojis personalizados** 😺: cada servidor pode ter até 50 (Configurações do servidor → *Emojis*). Use com `:nome:` (com autocompletar), pelo 😊 ou como reação. Funcionam também nas DMs de quem está no servidor. Nova permissão: *Gerenciar emojis*
- **Monitor**: job `nexo-monitor` no Jenkins confere tudo a cada 5 minutos, religa o que caiu e avisa no canal `#avisos`; e monitor externo grátis (UptimeRobot) para quando a VM inteira cair
- **Backup fora da VM**: script do Windows copia os backups todo dia para o OneDrive
- Guia: [docs/monitor-e-backup.md](docs/monitor-e-backup.md)
- **GIFs** 🎞️: botão **GIF** ao lado do 😊 (no celular: ＋ → *Enviar GIF*) para pesquisar e enviar GIFs em canais e DMs, via KLIPY. Precisa de uma chave grátis no `.env`: [docs/gifs.md](docs/gifs.md)
- **Compartilhar tela melhorado** 🖥️: escolha a qualidade (720p a **1440p 60 fps**), se é jogo/vídeo (fluidez) ou texto (nitidez) e se transmite o som. Quem assiste tem **tela cheia** (botão ⛶, duplo clique ou tecla F), **volume da transmissão** separado da voz da pessoa e vê a resolução/fps que está chegando

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
| POST | `/api/channels/:id/messages` | Envia `{ content }` (ou uma enquete: `{ content, poll: { question, options: ["a","b"], multiple, hours } }`) |
| PATCH/DELETE | `/api/messages/:id` | Edita/apaga as próprias mensagens |
| PUT/DELETE | `/api/messages/:id/reactions/:emoji` | Reage |

Tempo real: conecte no Socket.IO com `auth: { token: "Bot <token>" }` e escute `message:new`,
`message:updated`, `message:deleted`, `message:reactions`, `message:poll`, `presence`.
O texto das mensagens pode usar a mesma formatação das pessoas (`**negrito**`, `` `código` ``…).
Bots não podem criar servidores, entrar por convite, ter amigos ou entrar em canais de voz.
Limite: 5 mensagens a cada 5 segundos (acima disso a API responde 429).

## Deploy automático (Jenkins)

O `Jenkinsfile` faz: baixar do GitHub → gerar a imagem → conferir a sintaxe → subir → testar o `/health`.
O Jenkins verifica o GitHub a cada ~2 minutos. Ele precisa de duas credenciais:
`github-nexo` (usuário + token do GitHub) e `nexo-env` (o arquivo `.env`, como "Secret file").

A imagem do Jenkins com Docker fica em `infra/jenkins/` (`bash infra/jenkins/recriar-jenkins.sh`).

## Backup

O job **nexo-backup** do Jenkins (arquivo `infra/backup/Jenkinsfile`) roda todo dia de madrugada e
guarda em `/var/backups/nexo` (na VM) uma pasta por dia com o banco (`banco.dump`) e os anexos/fotos
(`anexos.tar.gz`). Backups com mais de 14 dias são apagados (`BACKUP_KEEP_DAYS` no `.env`).

```bash
docker compose --profile backup run --rm --build backup     # fazer um backup agora
docker compose --profile backup run --rm backup listar      # ver os backups
bash infra/backup/restaurar.sh ultimo                       # voltar tudo para o último backup
```

O restaurar pede confirmação, faz antes um backup do estado atual e para/religa o app sozinho.
Para guardar uma cópia **fora da VM** (no Windows/OneDrive, todo dia sozinho), veja
[docs/monitor-e-backup.md](docs/monitor-e-backup.md).

## Estrutura

```
nexo/
├── docker-compose.yml       # app, Postgres, Caddy (HTTPS), LiveKit (voz) e bot de exemplo
├── Jenkinsfile              # pipeline de deploy
├── infra/
│   ├── caddy/               # HTTPS na frente do app
│   ├── livekit/             # servidor de voz e vídeo
│   ├── jenkins/             # imagem do Jenkins com acesso ao Docker
│   ├── backup/              # backup/restauração + Jenkinsfile do job diário
│   ├── windows/             # script que abre as portas de voz no Windows
│   └── completar-env.sh     # gera as configurações novas no .env
├── docker-compose.publico.yml  # complemento: túnel da Cloudflare (acesso pela internet)
├── docs/acesso-externo.md   # passo a passo do domínio + Cloudflare
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
- Login bloqueia por 15 minutos depois de 10 senhas erradas (por IP + usuário).
- Na internet, use `REGISTRATION_CODE` no `.env` para só quem tem o código conseguir criar conta.
- Fotos de perfil: o servidor confere que o arquivo é mesmo PNG/JPG/GIF/WEBP (pelos bytes) e limita a 2 MB.

## Limitações conhecidas

- Voz pela internet precisa das portas 7881/TCP e 7882/UDP abertas no roteador e de uma internet
  sem CGNAT (veja [docs/acesso-externo.md](docs/acesso-externo.md)).
- Threads sem mensagens há mais de 7 dias somem da barra lateral (continuam acessíveis pelo 🧵 na mensagem).
- "Pular para mensagem" carrega até ~2000 mensagens para trás.
- Se alguém perder a permissão de voz enquanto já está num canal, só sai na próxima vez que entrar.
