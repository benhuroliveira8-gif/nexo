// Gerador de QR code (modo byte, correção "M", versões 1 a 10). Usado para configurar o 2FA.
// Devolve uma matriz de booleanos (true = quadradinho preto).

// [total de codewords de dados por bloco..., codewords de correção por bloco]
const BLOCKS_M = [null,
  [[16], 10], [[28], 16], [[44], 26], [[32, 32], 18], [[43, 43], 24],
  [[27, 27, 27, 27], 16], [[31, 31, 31, 31], 18], [[38, 38, 39, 39], 22],
  [[36, 36, 36, 37, 37], 22], [[43, 43, 43, 43, 44], 26]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// ---------- Reed-Solomon em GF(256)
const EXP = new Array(512);
const LOG = new Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 256) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gmul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const res = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ res.shift();
    res.push(0);
    for (let i = 0; i < degree; i++) res[i] ^= gmul(gen[i + 1], factor);
  }
  return res;
}

// ---------- Montagem
function bchBits(value, poly, polyBits) {
  let v = value << (polyBits - 1);
  for (let i = 31 - Math.clz32(v); i >= polyBits - 1; i--) {
    if (v & (1 << i)) v ^= poly << (i - (polyBits - 1));
  }
  return (value << (polyBits - 1)) | v;
}

export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  for (; version <= 10; version++) {
    const cap = BLOCKS_M[version][0].reduce((a, b) => a + b, 0);
    const bits = 4 + (version < 10 ? 8 : 16) + bytes.length * 8;
    if (bits <= cap * 8) break;
  }
  if (version > 10) throw new Error('Texto grande demais para o QR code.');
  const [blockSizes, ecLen] = BLOCKS_M[version];
  const capacity = blockSizes.reduce((a, b) => a + b, 0);

  // Bits: modo byte (0100) + tamanho + dados + terminador + preenchimento.
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  bytes.forEach((b) => put(b, 8));
  put(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  // Divide em blocos, calcula a correção e intercala.
  const blocks = [];
  let off = 0;
  for (const size of blockSizes) {
    const d = data.slice(off, off + size);
    off += size;
    blocks.push({ d, e: rsRemainder(d, ecLen) });
  }
  const codewords = [];
  const maxD = Math.max(...blockSizes);
  for (let i = 0; i < maxD; i++) blocks.forEach((b) => { if (i < b.d.length) codewords.push(b.d[i]); });
  for (let i = 0; i < ecLen; i++) blocks.forEach((b) => codewords.push(b.e[i]));

  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, v) => { m[r][c] = v; fixed[r][c] = true; };

  // Padrões de localização (os 3 quadrados grandes) + separadores.
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const on = r >= 0 && r <= 6 && c >= 0 && c <= 6
          && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(rr, cc, on);
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  // Linhas de tempo
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // Padrões de alinhamento
  const al = ALIGN[version];
  for (const r of al) {
    for (const c of al) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  }
  // Módulo escuro e áreas reservadas do formato/versão.
  set(size - 8, 8, true);
  for (let i = 0; i < 9; i++) { if (!fixed[8][i]) set(8, i, false); if (!fixed[i][8]) set(i, 8, false); }
  for (let i = 0; i < 8; i++) { set(8, size - 1 - i, false); set(size - 1 - i, 8, false); }
  if (version >= 7) {
    const vbits = bchBits(version, 0x1f25, 13);
    for (let i = 0; i < 18; i++) {
      const bit = ((vbits >> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      set(a, b, bit);
      set(b, a, bit);
    }
  }

  // Coloca os dados em zigue-zague.
  const dataBits = [];
  codewords.forEach((cw) => { for (let i = 7; i >= 0; i--) dataBits.push((cw >>> i) & 1); });
  let k = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const row = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        if (fixed[row][col]) continue;
        m[row][col] = k < dataBits.length ? dataBits[k] === 1 : false;
        k++;
      }
    }
    upward = !upward;
  }

  // Escolhe a máscara com menor penalidade.
  const MASKS = [
    (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const g = m.map((row, r) => row.map((v, c) => (fixed[r][c] ? v : v !== MASKS[mask](r, c))));
    drawFormat(g, size, mask);
    const score = penalty(g, size);
    if (!best || score < best.score) best = { score, g };
  }
  return best.g;
}

function drawFormat(g, size, mask) {
  const bits = bchBits((0 << 3) | mask, 0x537, 11) ^ 0x5412; // nível M = 00
  const bit = (i) => ((bits >> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) g[i][8] = bit(i);
  g[7][8] = bit(6);
  g[8][8] = bit(7);
  g[8][7] = bit(8);
  for (let i = 9; i < 15; i++) g[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i++) g[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) g[size - 15 + i][8] = bit(i);
  g[size - 8][8] = true;
}

function penalty(g, size) {
  let score = 0;
  const lineScore = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
      for (let b = 0; b + 6 < size; b++) {
        const p = [1, 0, 1, 1, 1, 0, 1].every((v, i) => get(a, b + i) === (v === 1));
        if (p) {
          const before = b >= 4 && [1, 2, 3, 4].every((i) => !get(a, b - i));
          const after = b + 10 < size && [7, 8, 9, 10].every((i) => !get(a, b + i));
          if (before || after) score += 40;
        }
      }
    }
  };
  lineScore((r, c) => g[r][c]);
  lineScore((c, r) => g[r][c]);
  let dark = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (g[r][c]) dark++;
      if (r + 1 < size && c + 1 < size && g[r][c] === g[r + 1][c] && g[r][c] === g[r][c + 1] && g[r][c] === g[r + 1][c + 1]) score += 3;
    }
  }
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return score;
}

// Desenha como SVG (com margem branca de 4 módulos).
export function qrSvg(text, px = 200) {
  const g = qrMatrix(text);
  const n = g.length + 8;
  let path = '';
  g.forEach((row, r) => row.forEach((v, c) => { if (v) path += `M${c + 4} ${r + 4}h1v1h-1z`; }));
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
  svg.setAttribute('width', String(px));
  svg.setAttribute('height', String(px));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code');
  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('width', String(n));
  bg.setAttribute('height', String(n));
  bg.setAttribute('fill', '#fff');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  p.setAttribute('fill', '#000');
  svg.append(bg, p);
  return svg;
}
