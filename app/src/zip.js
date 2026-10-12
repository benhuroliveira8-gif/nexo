// Gerador de .zip simples (sem bibliotecas), escrevendo direto na resposta.
// Texto vai comprimido; fotos/vídeos (que já são comprimidos) vão "guardados".
const zlib = require('zlib');

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

class ZipWriter {
  constructor(out) {
    this.out = out;          // stream gravável (ex.: res do Express)
    this.offset = 0;
    this.entries = [];
  }

  write(buf) {
    this.offset += buf.length;
    return this.out.write(buf) ? Promise.resolve() : new Promise((r) => this.out.once('drain', r));
  }

  // name: caminho dentro do zip; data: Buffer ou texto; compress: true para texto.
  async add(name, data, { compress = true, date = new Date() } = {}) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const body = compress ? zlib.deflateRawSync(raw, { level: 6 }) : raw;
    const method = compress ? 8 : 0;
    const crc = zlib.crc32(raw) >>> 0;
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date: d } = dosTime(date);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // nomes em UTF-8
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(d, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    this.entries.push({ nameBuf, method, time, d, crc, csize: body.length, size: raw.length, offset: this.offset });
    await this.write(header);
    await this.write(nameBuf);
    await this.write(body);
  }

  async finish() {
    const start = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.d, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.csize, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.nameBuf.length, 28);
      c.writeUInt32LE(e.offset, 42);
      await this.write(c);
      await this.write(e.nameBuf);
    }
    const size = this.offset - start;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
    this.out.end();
  }
}

module.exports = { ZipWriter };
