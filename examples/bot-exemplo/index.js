// Bot de exemplo do Nexo.
// Ele fica conectado em tempo real e responde a comandos que começam com "!".
//
// Como rodar (no servidor):
//   1. No Nexo, clique no seu nome (embaixo, à esquerda) → Desenvolvedor → Criar bot.
//   2. Copie o token e coloque no .env:   BOT_TOKEN=nexo.123.xxxxx
//   3. Adicione o bot a um servidor (na mesma tela, "Adicionar a um servidor").
//   4. docker compose --profile bots up -d --build bot-exemplo
//
// Para criar comandos novos, é só adicionar uma entrada em COMMANDS lá embaixo.
const { io } = require('socket.io-client');

const NEXO_URL = process.env.NEXO_URL || 'http://localhost:3000';
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('Falta o BOT_TOKEN. Crie um bot no Nexo (seu nome → Desenvolvedor) e coloque o token no .env.');
  process.exit(1);
}

// ---------------------------------------------------------------- API do Nexo

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${NEXO_URL}/api${path}`, {
    method,
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

const send = (channelId, content) => api(`/channels/${channelId}/messages`, { method: 'POST', body: { content } });
const react = (messageId, emoji) => api(`/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, { method: 'PUT' });

// ---------------------------------------------------------------- Comandos

const startedAt = Date.now();

const COMMANDS = {
  ajuda: {
    help: 'mostra esta lista',
    run: (msg) => send(msg.channelId, ['Comandos que eu conheço:',
      ...Object.entries(COMMANDS).map(([name, c]) => `• !${name} — ${c.help}`)].join('\n')),
  },
  ping: {
    help: 'responde pong e mostra o tempo de resposta',
    run: async (msg) => {
      const t = Date.now();
      await send(msg.channelId, '🏓 pong!');
      console.log(`ping respondido em ${Date.now() - t} ms`);
    },
  },
  dado: {
    help: 'rola um dado (ex.: !dado 20)',
    run: (msg, args) => {
      const sides = Math.min(Math.max(parseInt(args[0], 10) || 6, 2), 1000);
      const roll = 1 + Math.floor(Math.random() * sides);
      return send(msg.channelId, `🎲 ${msg.author.displayName} rolou um d${sides}: ${roll}`);
    },
  },
  eco: {
    help: 'repete o que você escrever (ex.: !eco olá)',
    run: (msg, args) => send(msg.channelId, args.join(' ') || 'Escreva algo depois do !eco 😉'),
  },
  uptime: {
    help: 'há quanto tempo estou ligado',
    run: (msg) => {
      const min = Math.floor((Date.now() - startedAt) / 60000);
      return send(msg.channelId, `⏱️ Estou ligado há ${min} minuto(s).`);
    },
  },
};

// ---------------------------------------------------------------- Conexão em tempo real

async function main() {
  const { user: me } = await api('/me');
  console.log(`Conectando como ${me.displayName} (@${me.username})...`);

  const socket = io(NEXO_URL, { auth: { token: `Bot ${BOT_TOKEN}` } });

  socket.on('connect', async () => {
    const { servers } = await api('/servers');
    console.log(`Online! Estou em ${servers.length} servidor(es): ${servers.map((s) => s.name).join(', ') || '(nenhum ainda)'}`);
  });

  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') {
      console.error('Token inválido. Gere um novo no Nexo (Desenvolvedor → Novo token).');
      process.exit(1);
    }
    console.error('Erro de conexão, tentando de novo:', err.message);
  });

  socket.on('disconnect', (reason) => console.log('Desconectado:', reason));

  socket.on('message:new', async (msg) => {
    if (msg.author.isBot) return; // nunca responde a bots (inclusive a si mesmo)

    // Dá "oi" de volta com uma reação.
    if (/\boi\b/i.test(msg.content) && msg.content.toLowerCase().includes(`@${me.username}`)) {
      react(msg.id, '👋').catch(() => {});
    }

    if (!msg.content.startsWith('!')) return;
    const [name, ...args] = msg.content.slice(1).trim().split(/\s+/);
    const command = COMMANDS[(name || '').toLowerCase()];
    if (!command) return;
    try {
      await command.run(msg, args);
    } catch (err) {
      console.error(`Erro no comando !${name}:`, err.message);
    }
  });
}

main().catch((err) => {
  console.error('Não foi possível iniciar o bot:', err.message);
  process.exit(1);
});
