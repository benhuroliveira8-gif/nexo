// Gerador de QR code (modo byte, correção de erro nível M, versões 1 a 15).
// Usado para configurar a verificação em duas etapas: o app autenticador lê o QR.
// Devolve uma matriz de booleanos (true = quadradinho preto).

// [blocos do grupo 1, dados por bloco do grupo 1, blocos do grupo 2, dados por bloco do grupo 2, correção por bloco]
const BLOCKS_M = [null,
  [1, 16, 0, 0, 10], [1, 28, 0, 0, 16], [1, 44, 0, 0, 26], [2, 32, 0, 0, 18], [2, 43, 0, 0, 24],
  [4, 27, 0, 0, 16], [4, 31, 0, 0, 18], [2, 38, 2, 39, 22], [3, 36, 2, 37, 22], [4, 43, 1, 44, 26],
  [1, 50, 4, 51, 30], [6, 36, 2, 37, 22], [8, 37, 1, 38, 22], [4, 40, 5, 41, 24], [5, 41, 5, 42, 24],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
  [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70]];

// ---------------------------------------------------------------- Reed-Solomon em GF(256)
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= mul(gen[i + 1], factor);
  }
  return rem;
}

// ---------------------------------------------------------------- Montagem dos dados

function encodeData(bytes, version) {
  const [b1, d1, b2, d2, ec] = BLOCKS_M[version];
  const capacity = b1 * d1 + b2 * d2;
  const bits = [];
  const push = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  bytes.forEach((b) => push(b, 8));
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  // Divide em blocos, calcula a correção e intercala.
  const blocks = [];
  let pos = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const len = i < b1 ? d1 : d2;
    const chunk = data.slice(pos, pos + len);
    pos += len;
    blocks.push({ data: chunk, ec: rsRemainder(chunk, ec) });
  }
  const out = [];
  for (let i = 0; i < Math.max(d1, d2); i++) blocks.forEach((b) => { if (i < b.data.length) out.push(b.data[i]); });
  for (let i = 0; i < ec; i++) blocks.forEach((b) => out.push(b.ec[i]));
  return out;
}

// ---------------------------------------------------------------- Desenho da matriz

function bch(value, poly, polyBits) {
  let v = value << (polyBits - 1);
  for (let i = 31 - Math.clz32(v); i >= polyBits - 1; i = 31 - Math.clz32(v)) v ^= poly << (i - polyBits + 1);
  return v;
}

function baseMatrix(version) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const set = (r, c, v) => { if (r >= 0 && c >= 0 && r < size && c < size) m[r][c] = v; };
  const finder = (r, c) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark = inside && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        set(r + dr, c + dc, dark);
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { m[6][i] = i % 2 === 0; m[i][6] = i % 2 === 0; }
  const pos = ALIGN[version];
  const last = pos[pos.length - 1];
  for (const r of pos) {
    for (const c of pos) {
      // Não desenha onde cairia em cima dos 3 quadrados de canto.
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) m[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
    }
  }
  m[size - 8][8] = true; // módulo escuro fixo
  // Reserva as áreas de formato/versão (preenchidas depois).
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = false;
    if (m[i][8] === null) m[i][8] = false;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = false;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = false;
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { m[i][size - 11 + j] = false; m[size - 11 + j][i] = false; }
  }
  return m;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function placeData(base, codewords, mask) {
  const size = base.length;
  const m = base.map((row) => row.slice());
  const fixed = base.map((row) => row.map((v) => v !== null));
  const bits = [];
  codewords.forEach((b) => { for (let i = 7; i >= 0; i--) bits.push((b >>> i) & 1); });
  let k = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const r = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (fixed[r][c]) continue;
        const bit = k < bits.length ? bits[k++] === 1 : false;
        m[r][c] = bit !== MASKS[mask](r, c);
      }
    }
    upward = !upward;
  }
  return m;
}

function placeFormat(m, mask, version) {
  const size = m.length;
  const format = (((0b00 << 3) | mask) << 10 | bch((0b00 << 3) | mask, 0x537, 11)) ^ 0x5412;
  const bit = (i) => ((format >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) m[8][i] = bit(14 - i);
  m[8][7] = bit(8); m[8][8] = bit(7); m[7][8] = bit(6);
  for (let i = 9; i < 15; i++) m[14 - i][8] = bit(14 - i);
  for (let i = 0; i < 8; i++) m[size - 1 - i][8] = bit(14 - i);
  for (let i = 8; i < 15; i++) m[8][size - 15 + i] = bit(14 - i);
  m[size - 8][8] = true;
  if (version >= 7) {
    const v = (version << 12) | bch(version, 0x1f25, 13);
    for (let i = 0; i < 18; i++) {
      const b = ((v >>> i) & 1) === 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      m[r][c] = b; m[c][r] = b;
    }
  }
}

function penalty(m) {
  const size = m.length;
  let score = 0;
  const lines = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1;
      }
    }
  };
  lines((r, c) => m[r][c]);
  lines((c, r) => m[r][c]);
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
  }
  const pat = [true, false, true, true, true, false, true, false, false, false, false];
  const rev = [...pat].reverse();
  for (let r = 0; r < size; r++) for (let c = 0; c <= size - 11; c++) {
    for (const p of [pat, rev]) {
      if (p.every((v, i) => m[r][c + i] === v)) score += 40;
      if (p.every((v, i) => m[c + i][r] === v)) score += 40;
    }
  }
  const dark = m.flat().filter(Boolean).length;
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return score;
}

export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  while (version <= 15) {
    const [b1, d1, b2, d2] = BLOCKS_M[version];
    const header = 4 + (version < 10 ? 8 : 16);
    if (header + bytes.length * 8 <= (b1 * d1 + b2 * d2) * 8) break;
    version++;
  }
  if (version > 15) throw new Error('Texto grande demais para o QR code.');
  const codewords = encodeData(bytes, version);
  const base = baseMatrix(version);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = placeData(base, codewords, mask);
    placeFormat(m, mask, version);
    const score = penalty(m);
    if (!best || score < best.score) best = { m, score };
  }
  return best.m;
}

// Desenha como SVG (com a margem branca que os leitores precisam).
export function qrSvg(text, { size = 220, margin = 4 } = {}) {
  const m = qrMatrix(text);
  const n = m.length + margin * 2;
  let path = '';
  m.forEach((row, r) => row.forEach((dark, c) => { if (dark) path += `M${c + margin} ${r + margin}h1v1h-1z`; }));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('class', 'qr');
  const bg = document.createElementNS(svg.namespaceURI, 'rect');
  bg.setAttribute('width', n); bg.setAttribute('height', n); bg.setAttribute('fill', '#fff');
  const p = document.createElementNS(svg.namespaceURI, 'path');
  p.setAttribute('d', path); p.setAttribute('fill', '#000');
  svg.append(bg, p);
  return svg;
}
