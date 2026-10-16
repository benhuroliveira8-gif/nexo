// Envio de e-mail por SMTP (Gmail com "senha de app", Brevo, etc.), sem bibliotecas extras.
// Configuração no .env:
//   SMTP_HOST=smtp.gmail.com  SMTP_PORT=587  SMTP_USER=...  SMTP_PASS=...  SMTP_FROM="Nexo <...>"
// Porta 465 = TLS direto; qualquer outra = STARTTLS (obrigatório, a não ser com SMTP_INSECURE=1 nos testes).
const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');

const cfg = () => ({
  host: String(process.env.SMTP_HOST || '').trim(),
  port: Number(process.env.SMTP_PORT) || 587,
  user: String(process.env.SMTP_USER || '').trim(),
  pass: String(process.env.SMTP_PASS || ''),
  from: String(process.env.SMTP_FROM || process.env.SMTP_USER || '').trim(),
  insecure: process.env.SMTP_INSECURE === '1',
});

const enabled = () => { const c = cfg(); return !!(c.host && c.from); };

// Endereço "puro" de dentro de 'Nome <email@x>'.
const bareAddress = (s) => { const m = String(s).match(/<([^>]+)>/); return (m ? m[1] : s).trim(); };

// Cabeçalho com acentos (RFC 2047).
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
function encodeFrom(from) {
  const m = String(from).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m && m[1] ? `${encodeHeader(m[1])} <${m[2]}>` : from;
}

function buildMessage({ from, to, subject, text, html }) {
  const boundary = `nexo-${crypto.randomBytes(8).toString('hex')}`;
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  const lines = [
    `From: ${encodeFrom(from)}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${bareAddress(from).split('@')[1] || 'nexo'}>`,
    'MIME-Version: 1.0',
  ];
  if (html) {
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(text),
      `--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(html),
      `--${boundary}--`, '');
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(text));
  }
  // "Dot-stuffing": linha começando com ponto ganha outro ponto.
  return lines.join('\r\n').replace(/\r\n\./g, '\r\n..');
}

// Conversa SMTP simples: manda um comando e espera a resposta com o código esperado.
function session(socket) {
  let buf = '';
  const queue = []; // respostas que chegaram antes de alguém pedir
  let waiting = null;
  const onData = (d) => {
    buf += d.toString('utf8');
    // Resposta completa: última linha no formato "250 texto" (sem hífen).
    for (;;) {
      const lines = buf.split('\r\n');
      const i = lines.slice(0, -1).findIndex((l) => /^\d{3}( |$)/.test(l));
      if (i === -1) return;
      const reply = lines.slice(0, i + 1).join('\n');
      buf = lines.slice(i + 1).join('\r\n');
      if (waiting) { const w = waiting; waiting = null; w(reply); } else queue.push(reply);
    }
  };
  const api = {
    attach(s) { s.on('data', onData); },
    read: () => new Promise((resolve) => { if (queue.length) resolve(queue.shift()); else waiting = resolve; }),
    async cmd(line, expect) {
      const p = api.read();
      if (line !== null) api.sock.write(`${line}\r\n`);
      const reply = await p;
      const code = Number(reply.slice(0, 3));
      if (!expect.includes(code)) {
        const safe = /^AUTH|^[A-Za-z0-9+/=]{8,}$/.test(line || '') ? '(login)' : line;
        throw new Error(`SMTP ${safe || 'conexão'}: ${reply.replace(/\s+/g, ' ').slice(0, 200)}`);
      }
      return reply;
    },
    sock: socket,
  };
  api.attach(socket);
  return api;
}

async function send({ to, subject, text, html }) {
  const c = cfg();
  if (!enabled()) throw new Error('E-mail não configurado (SMTP_HOST/SMTP_FROM).');
  const implicitTls = c.port === 465;
  const raw = implicitTls
    ? tls.connect({ host: c.host, port: c.port, servername: c.host })
    : net.connect({ host: c.host, port: c.port });
  raw.setTimeout(20000, () => raw.destroy(new Error('SMTP: tempo esgotado.')));
  const failed = new Promise((_, reject) => raw.once('error', reject));
  failed.catch(() => {});
  const run = async () => {
    let s = session(raw);
    await s.cmd(null, [220]);
    const helo = os.hostname().replace(/[^\w.-]/g, '') || 'nexo';
    let ehlo = await s.cmd(`EHLO ${helo}`, [250]);
    if (!implicitTls) {
      if (/STARTTLS/i.test(ehlo)) {
        await s.cmd('STARTTLS', [220]);
        const secure = tls.connect({ socket: raw, servername: c.host, rejectUnauthorized: !c.insecure });
        await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
        raw.removeAllListeners('data');
        s = session(secure);
        ehlo = await s.cmd(`EHLO ${helo}`, [250]);
      } else if (!c.insecure) {
        throw new Error('O servidor SMTP não oferece STARTTLS (conexão sem criptografia recusada).');
      }
    }
    if (c.user) {
      if (/AUTH[^\n]*PLAIN/i.test(ehlo)) {
        await s.cmd(`AUTH PLAIN ${Buffer.from(`\0${c.user}\0${c.pass}`).toString('base64')}`, [235]);
      } else {
        await s.cmd('AUTH LOGIN', [334]);
        await s.cmd(Buffer.from(c.user).toString('base64'), [334]);
        await s.cmd(Buffer.from(c.pass).toString('base64'), [235]);
      }
    }
    await s.cmd(`MAIL FROM:<${bareAddress(c.from)}>`, [250]);
    await s.cmd(`RCPT TO:<${bareAddress(to)}>`, [250, 251]);
    await s.cmd('DATA', [354]);
    await s.cmd(`${buildMessage({ from: c.from, to, subject, text, html })}\r\n.`, [250]);
    s.sock.write('QUIT\r\n');
    s.sock.end();
  };
  try {
    await Promise.race([run(), failed]);
  } finally {
    setTimeout(() => raw.destroy(), 1000).unref();
  }
}

// Modelo dos e-mails do Nexo (texto simples + HTML bem básico).
function codeEmail({ title, intro, code, outro }) {
  const text = `${title}\n\n${intro}\n\n    ${code}\n\n${outro}\n\n— Nexo`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f2f3f5;padding:24px">
<div style="max-width:440px;margin:auto;background:#fff;border-radius:12px;padding:24px;color:#1a1d24">
<h2 style="margin:0 0 12px">${esc(title)}</h2><p>${esc(intro)}</p>
<p style="font-size:32px;letter-spacing:8px;font-weight:bold;text-align:center;background:#f2f3f5;border-radius:8px;padding:12px">${esc(code)}</p>
<p style="color:#555">${esc(outro)}</p><p style="color:#888">— Nexo</p></div></body></html>`;
  return { text, html };
}

module.exports = { enabled, send, codeEmail, bareAddress };
