// MTProto obfuscated2: разбор 64-байтного init клиента и нарезка потока на транспортные пакеты.
// Схема: AES-256-CTR, ключ init[8:40], IV init[40:56]; после расшифровки init[56:60] — тег транспорта,
// init[60:62] — номер DC (int16 LE, отрицательный — media DC).
import { createCipheriv, createDecipheriv, randomBytes, type Decipheriv } from 'node:crypto';

export const TAG_ABRIDGED = 0xefefefef;
export const TAG_INTERMEDIATE = 0xeeeeeeee;
export const TAG_PADDED = 0xdddddddd;

export type Transport = 'abridged' | 'intermediate' | 'padded';

export interface ObfsInit {
  transport: Transport;
  dc: number; // со знаком: -2 = media DC2
  decipher: Decipheriv; // поток клиента→сервера, уже прокручен за 64 байта init
}

export function parseInit(init: Buffer): ObfsInit | null {
  if (init.length < 64) return null;
  const key = init.subarray(8, 40);
  const iv = init.subarray(40, 56);
  const decipher = createDecipheriv('aes-256-ctr', key, iv);
  const dec = decipher.update(init.subarray(0, 64));
  const tag = dec.readUInt32LE(56);
  const transport: Transport | null =
    tag === TAG_ABRIDGED ? 'abridged' : tag === TAG_INTERMEDIATE ? 'intermediate' : tag === TAG_PADDED ? 'padded' : null;
  if (!transport) return null;
  return { transport, dc: dec.readInt16LE(60), decipher };
}

/**
 * Режет зашифрованный поток клиента на целые транспортные пакеты (WebSocket Telegram ждёт пакет на сообщение).
 * Исходные байты не меняются — расшифровка только чтобы найти границы.
 */
export class PacketSplitter {
  private enc: Buffer[] = [];
  private dec = Buffer.alloc(0);
  private encLen = 0;

  constructor(private readonly init: ObfsInit) {}

  push(chunk: Buffer): Buffer[] {
    this.enc.push(chunk);
    this.encLen += chunk.length;
    this.dec = Buffer.concat([this.dec, this.init.decipher.update(chunk)]);
    const out: Buffer[] = [];
    for (;;) {
      const size = this.nextPacketSize();
      if (size === null || size > this.dec.length) break;
      const all = Buffer.concat(this.enc);
      out.push(all.subarray(0, size));
      this.enc = size < all.length ? [all.subarray(size)] : [];
      this.encLen -= size;
      this.dec = this.dec.subarray(size);
    }
    return out;
  }

  /** Байты, не сложившиеся в пакет (при закрытии отправим как есть) */
  rest(): Buffer | null {
    return this.encLen ? Buffer.concat(this.enc) : null;
  }

  private nextPacketSize(): number | null {
    const d = this.dec;
    if (this.init.transport === 'abridged') {
      if (d.length < 1) return null;
      const b = d[0] & 0x7f;
      if (b < 0x7f) return 1 + b * 4;
      if (d.length < 4) return null;
      return 4 + d.readUIntLE(1, 3) * 4;
    }
    if (d.length < 4) return null;
    return 4 + (d.readUInt32LE(0) & 0x7fffffff);
  }
}

// ---------- клиентская сторона (для самопроверки прокси) ----------

/** Сгенерировать init как это делает клиент Telegram */
export function makeClientInit(dc: number, tag = TAG_INTERMEDIATE) {
  let init: Buffer;
  for (;;) {
    init = randomBytes(64);
    const first = init.readUInt32LE(0);
    if (init[0] === 0xef) continue;
    if ([0x44414548, 0x54534f50, 0x20544547, 0x4954504f, 0xdddddddd, 0xeeeeeeee, 0x02010316].includes(first)) continue;
    if (init.readUInt32LE(4) === 0) continue;
    break;
  }
  init.writeUInt32LE(tag, 56);
  init.writeInt16LE(dc, 60);
  const encKey = init.subarray(8, 40);
  const encIv = init.subarray(40, 56);
  const rev = Buffer.from(init.subarray(8, 56)).reverse();
  const encryptor = createCipheriv('aes-256-ctr', encKey, encIv);
  const decryptor = createDecipheriv('aes-256-ctr', rev.subarray(0, 32), rev.subarray(32, 48));
  const encrypted = encryptor.update(init);
  const wire = Buffer.concat([init.subarray(0, 56), encrypted.subarray(56, 64)]);
  return { wire, encryptor, decryptor };
}
