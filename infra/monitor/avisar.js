// Manda o aviso do monitor para o canal "avisos" (o primeiro que o bot encontrar),
// mencionando o dono do servidor para chegar notificação no celular.
// Roda dentro do container do app: docker compose exec -T -e AVISO="..." app node - < avisar.js
(async () => {
  const token = String(process.env.BOT_TOKEN || '').trim();
  const texto = String(process.env.AVISO || '').slice(0, 3800);
  if (!token || !texto) return;
  const api = async (path, opts = {}) => {
    const res = await fetch(`http://localhost:3000/api${path}`, {
      ...opts,
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };
  const { servers } = await api('/servers');
  for (const s of servers) {
    const d = await api(`/servers/${s.id}`);
    const canal = d.channels.find((c) => c.kind === 'text' && c.name === 'avisos');
    if (!canal) continue;
    const dono = d.members.find((m) => m.id === d.server.ownerId);
    const content = `${dono ? `@${dono.username} ` : ''}${texto}`;
    await api(`/channels/${canal.id}/messages`, { method: 'POST', body: JSON.stringify({ content }) });
    console.log(`Aviso enviado em #avisos de "${s.name}".`);
    return;
  }
  console.log('Não achei nenhum canal chamado "avisos" em que o bot esteja. Crie o canal #avisos no seu servidor.');
})().catch((err) => { console.error('Erro ao avisar:', err.message); process.exit(1); });
