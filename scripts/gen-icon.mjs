// Генерирует иконки приложения без внешних зависимостей:
//   build/icon.png (256), build/icon.ico (16..256, PNG внутри), build/tray-on.png / tray-off.png (32)
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
mkdirSync(OUT, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const clamp = (v) => Math.max(0, Math.min(1, v));

// Логотип: скруглённый квадрат с градиентом и белая «Z» из трёх штрихов
function logo(colorA, colorB) {
  return (x, y, size) => {
    const ss = 4; // суперсэмплинг для сглаживания
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const u = (x + (sx + 0.5) / ss) / size, v = (y + (sy + 0.5) / ss) / size;
      const r = 0.22, m = 0.04;
      const qx = Math.max(Math.abs(u - 0.5) - (0.5 - m - r), 0), qy = Math.max(Math.abs(v - 0.5) - (0.5 - m - r), 0);
      const inside = Math.hypot(qx, qy) <= r;
      if (!inside) continue;
      const t = clamp((u + v) / 2);
      let col = colorA.map((c, i) => c + (colorB[i] - c) * t);
      const w = 0.075;
      const d = Math.min(segDist(u, v, 0.3, 0.3, 0.7, 0.3), segDist(u, v, 0.7, 0.3, 0.3, 0.7), segDist(u, v, 0.3, 0.7, 0.7, 0.7));
      if (d < w) col = [255, 255, 255];
      acc = [acc[0] + col[0], acc[1] + col[1], acc[2] + col[2], acc[3] + 255];
    }
    const n = ss * ss;
    const a = acc[3] / n;
    return a ? [Math.round(acc[0] / (acc[3] / 255)), Math.round(acc[1] / (acc[3] / 255)), Math.round(acc[2] / (acc[3] / 255)), Math.round(a)] : [0, 0, 0, 0];
  };
}

const ON = logo([30, 160, 255], [36, 210, 150]);
const OFF = logo([90, 100, 115], [60, 68, 80]);

writeFileSync(join(OUT, 'icon.png'), png(256, ON));
writeFileSync(join(OUT, 'tray-on.png'), png(32, ON));
writeFileSync(join(OUT, 'tray-off.png'), png(32, OFF));

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((s) => png(s, ON));
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(images[i].length, 8); e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return e;
});
writeFileSync(join(OUT, 'icon.ico'), Buffer.concat([header, ...entries, ...images]));
console.log('✓ build/icon.ico, icon.png, tray-on.png, tray-off.png');
