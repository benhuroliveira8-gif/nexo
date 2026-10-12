// Tira o texto de PDFs (e de arquivos .txt/.csv/.md) para a busca encontrar o que está dentro.
// É um leitor simples, sem bibliotecas: funciona com a maioria dos PDFs "de texto"
// (gerados por Word, Google Docs, navegadores...). PDF escaneado (só imagem) não tem texto.
const zlib = require('zlib');

const MAX_TEXT = 200 * 1024;      // guarda no máximo 200 mil caracteres
const MAX_STREAMS = 400;

function decodePdfString(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[++i];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b' || n === 'f') out += ' ';
    else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(s[i + 1])) oct += s[++i];
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
    } else if (n === '\n' || n === '\r') { if (n === '\r' && s[i + 1] === '\n') i++; } else out += n;
  }
  return out;
}

// Tabela "ToUnicode" das fontes: diz qual letra é cada código (PDFs do Chrome, Word com
// fontes embutidas...). Juntamos as tabelas de todas as fontes numa só (simples e quase sempre certo).
function hexToStr(h) {
  let s = '';
  for (let i = 0; i + 3 < h.length + 1 && i < h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4).padEnd(4, '0'), 16));
  return s;
}
function parseCMap(text, cmap) {
  const cs = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(text);
  if (cs) cmap.codeLen = Math.max(cmap.codeLen || 0, cs[1].length / 2);
  let m;
  const chars = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = chars.exec(text))) {
    const pairs = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g;
    let p;
    while ((p = pairs.exec(m[1]))) cmap.map.set(parseInt(p[1], 16), hexToStr(p[2]));
  }
  const ranges = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = ranges.exec(text))) {
    const items = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g;
    let p;
    while ((p = items.exec(m[1]))) {
      const lo = parseInt(p[1], 16);
      const hi = Math.min(parseInt(p[2], 16), lo + 5000);
      if (p[3] !== undefined) {
        const base = hexToStr(p[3]);
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi; c++) cmap.map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - lo)));
      } else {
        const list = p[4].match(/<([0-9a-fA-F]*)>/g) || [];
        list.forEach((x, i) => cmap.map.set(lo + i, hexToStr(x.slice(1, -1))));
      }
    }
  }
}
let CMAP = null; // tabela do PDF que está sendo lido agora

// Texto em hexadecimal: <0048006F> (UTF-16) ou <486F6C61> (1 byte por letra).
function decodeHex(hex) {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  if (!clean) return '';
  if (CMAP && CMAP.map.size) {
    const len = (CMAP.codeLen || 2) * 2;
    let s = '';
    for (let i = 0; i < clean.length; i += len) {
      const code = parseInt(clean.slice(i, i + len), 16);
      s += CMAP.map.has(code) ? CMAP.map.get(code) : '';
    }
    if (s) return s;
  }
  const bytes = Buffer.from(clean.length % 2 ? `${clean}0` : clean, 'hex');
  if (bytes.length >= 2 && bytes.length % 2 === 0 && bytes.filter((b, i) => i % 2 === 0 && b === 0).length > bytes.length / 4) {
    let s = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  return bytes.toString('latin1');
}

// Texto "(...)" em fonte com tabela de 1 byte: troca cada código pela letra certa.
function viaCMap(str) {
  if (!CMAP || CMAP.codeLen !== 1 || !CMAP.map.size) return str;
  let out = '';
  for (const ch of str) {
    const c = ch.charCodeAt(0);
    out += CMAP.map.has(c) ? CMAP.map.get(c) : ch;
  }
  return out;
}

// Lê os operadores de texto de um "content stream": (texto) Tj, [(a) -20 (b)] TJ, ' e ".
function textFromContent(content) {
  const out = [];
  const re = /\[((?:\\.|[^\]\\])*)\]\s*TJ|\(((?:\\.|[^)\\])*)\)\s*(?:Tj|'|")|<([0-9A-Fa-f\s]+)>\s*Tj|(T\*|ET|Td|TD|Tm)\b/g;
  let m;
  let line = '';
  while ((m = re.exec(content))) {
    if (m[1] !== undefined) {
      const parts = m[1].match(/\((?:\\.|[^)\\])*\)|<[0-9A-Fa-f\s]*>|-?\d+(?:\.\d+)?/g) || [];
      for (const p of parts) {
        if (p.startsWith('(')) line += viaCMap(decodePdfString(p.slice(1, -1)));
        else if (p.startsWith('<')) line += decodeHex(p.slice(1, -1));
        else if (Number(p) < -200) line += ' '; // espaço grande entre palavras
      }
    } else if (m[2] !== undefined) line += viaCMap(decodePdfString(m[2]));
    else if (m[3] !== undefined) line += decodeHex(m[3]);
    else if (line) { out.push(line); line = ''; }
  }
  if (line) out.push(line);
  return out.join('\n');
}

function streams(buf, src) {
  const list = [];
  let idx = 0;
  let count = 0;
  while (count++ < MAX_STREAMS) {
    const s = src.indexOf('stream', idx);
    if (s === -1) break;
    const e = src.indexOf('endstream', s);
    if (e === -1) break;
    const dictStart = src.lastIndexOf('<<', s);
    const dict = dictStart !== -1 ? src.slice(dictStart, s) : '';
    let start = s + 6;
    if (src[start] === '\r') start++;
    if (src[start] === '\n') start++;
    const raw = buf.subarray(start, e);
    idx = e + 9;
    if (/\/Subtype\s*\/Image/.test(dict)) continue;
    let data = raw;
    if (/\/FlateDecode/.test(dict)) {
      try { data = zlib.inflateSync(raw); } catch { try { data = zlib.inflateRawSync(raw.subarray(2)); } catch { continue; } }
    } else if (/\/Filter/.test(dict)) continue;
    list.push(data.toString('latin1'));
  }
  return list;
}

function pdfText(buf) {
  const src = buf.toString('latin1');
  const all = streams(buf, src);
  CMAP = { map: new Map(), codeLen: 0 };
  for (const t of all) if (t.includes('begincmap')) parseCMap(t, CMAP);
  try {
    const parts = [];
    for (const t of all) {
      if (t.includes('begincmap')) continue;
      const x = textFromContent(t);
      if (x.trim()) parts.push(x);
      if (parts.join('\n').length > MAX_TEXT) break;
    }
    return clean(parts.join('\n'));
  } finally { CMAP = null; }
}

// Descarta lixo (fontes com codificação própria viram símbolos sem sentido).
function clean(text) {
  const t = String(text || '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);
  if (!t) return null;
  const letters = (t.match(/[\p{L}\p{N}\s.,;:!?()'"-]/gu) || []).length;
  return letters / t.length > 0.7 ? t : null;
}

const TEXT_TYPES = /^text\/(plain|csv|markdown|x-markdown)$|^application\/(json|csv)$/;

// Devolve o texto (ou null) de um arquivo enviado.
function extractText(data, contentType, filename) {
  try {
    if (contentType === 'application/pdf' || /\.pdf$/i.test(filename)) {
      return data.subarray(0, 5).toString() === '%PDF-' ? pdfText(data) : null;
    }
    if (TEXT_TYPES.test(contentType) || /\.(txt|csv|md|log)$/i.test(filename)) return clean(data.toString('utf8'));
  } catch { /* arquivo estranho: sem texto */ }
  return null;
}

module.exports = { extractText, pdfText };
