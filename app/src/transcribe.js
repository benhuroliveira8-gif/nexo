// Transcrição das mensagens de voz no servidor (opcional), com o Whisper rodando num
// container próprio (perfil "transcricao" do docker compose). Sem WHISPER_URL, fica desligado
// e vale só a transcrição que o navegador faz enquanto a pessoa grava.
const fs = require('fs');
const path = require('path');
const db = require('./db');

const URL_BASE = String(process.env.WHISPER_URL || '').replace(/\/+$/, '');
const LANG = process.env.WHISPER_LANGUAGE || 'pt';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const enabled = () => !!URL_BASE;

const queue = [];
let running = false;

// Chamado quando uma mensagem nova tem áudio sem transcrição.
function enqueue(message, onDone) {
  if (!enabled()) return;
  for (const a of message.attachments || []) {
    if (a.isVoice && !a.transcript && /^[a-f0-9]{32}$/.test(a.id)) queue.push({ id: a.id, type: a.contentType, messageId: message.id, onDone });
  }
  if (queue.length > 200) queue.splice(0, queue.length - 200);
  run();
}

async function transcribeOne(job) {
  const data = await fs.promises.readFile(path.join(UPLOAD_DIR, job.id));
  const form = new FormData();
  form.append('audio_file', new Blob([data], { type: job.type || 'audio/webm' }), 'audio.webm');
  const res = await fetch(`${URL_BASE}/asr?task=transcribe&language=${encodeURIComponent(LANG)}&output=txt&encode=true`, {
    method: 'POST', body: form, signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`Whisper respondeu ${res.status}`);
  return (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 4000);
}

async function run() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      const text = await transcribeOne(job);
      if (text) {
        const { rowCount } = await db.query('UPDATE attachments SET transcript = $2 WHERE id = $1 AND transcript IS NULL', [job.id, text]);
        if (rowCount && job.onDone) await job.onDone(job.messageId);
      }
    } catch (err) {
      console.warn('Não deu para transcrever o áudio:', err.message);
    }
  }
  running = false;
}

module.exports = { enqueue, enabled };
