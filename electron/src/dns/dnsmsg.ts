// Минимальная работа с DNS-сообщениями (RFC 1035) для локального DoH-прокси

/** Пропустить имя (метки или указатель сжатия); позиция после имени или -1 */
function skipName(b: Buffer, pos: number): number {
  for (let i = 0; i < 128; i++) {
    if (pos >= b.length) return -1;
    const len = b[pos];
    if (len === 0) return pos + 1;
    if (len >= 0xc0) return pos + 2;
    pos += 1 + len;
  }
  return -1;
}

function readName(b: Buffer, pos: number): string {
  const labels: string[] = [];
  for (let guard = 0; guard < 128 && pos < b.length; guard++) {
    const len = b[pos];
    if (len === 0) break;
    if (len >= 0xc0) { pos = ((len & 0x3f) << 8) | b[pos + 1]; continue; }
    labels.push(b.subarray(pos + 1, pos + 1 + len).toString('latin1'));
    pos += 1 + len;
  }
  return labels.join('.').toLowerCase();
}

export interface Question { name: string; type: number; cls: number; end: number }

export function parseQuestion(b: Buffer): Question | null {
  if (b.length < 12 || b.readUInt16BE(4) < 1) return null;
  const end = skipName(b, 12);
  if (end < 0 || end + 4 > b.length) return null;
  return { name: readName(b, 12), type: b.readUInt16BE(end), cls: b.readUInt16BE(end + 2), end: end + 4 };
}

/** Размер UDP, который принимает клиент: из OPT (EDNS0) в запросе, иначе 512 */
export function clientUdpSize(q: Buffer): number {
  try {
    const qd = q.readUInt16BE(4), an = q.readUInt16BE(6), ns = q.readUInt16BE(8), ar = q.readUInt16BE(10);
    let pos = 12;
    for (let i = 0; i < qd; i++) { pos = skipName(q, pos); if (pos < 0) return 512; pos += 4; }
    for (let i = 0; i < an + ns + ar; i++) {
      pos = skipName(q, pos);
      if (pos < 0 || pos + 10 > q.length) return 512;
      const type = q.readUInt16BE(pos), cls = q.readUInt16BE(pos + 2), rdlen = q.readUInt16BE(pos + 8);
      if (type === 41) return Math.max(512, Math.min(cls, 4096));
      pos += 10 + rdlen;
    }
  } catch { /* битый запрос */ }
  return 512;
}

/** Минимальный TTL ответов (для кэша); null — если ответов нет */
export function minTtl(b: Buffer): number | null {
  try {
    const qd = b.readUInt16BE(4), an = b.readUInt16BE(6);
    let pos = 12, min: number | null = null;
    for (let i = 0; i < qd; i++) { pos = skipName(b, pos); if (pos < 0) return null; pos += 4; }
    for (let i = 0; i < an; i++) {
      pos = skipName(b, pos);
      if (pos < 0 || pos + 10 > b.length) break;
      const ttl = b.readUInt32BE(pos + 4);
      min = min === null ? ttl : Math.min(min, ttl);
      pos += 10 + b.readUInt16BE(pos + 8);
    }
    return min;
  } catch {
    return null;
  }
}

/**
 * Подмена A-записей по карте «IP → IP» (то же, что lua z2k-win-dnsfix.lua делает в движке).
 * Возвращает новый буфер или null, если менять нечего. Длина сообщения не меняется.
 */
export function rewriteA(b: Buffer, map: Map<string, string>): Buffer | null {
  if (!map.size || b.length < 12) return null;
  try {
    const qd = b.readUInt16BE(4), an = b.readUInt16BE(6);
    let pos = 12, out: Buffer | null = null;
    for (let i = 0; i < qd; i++) { pos = skipName(b, pos); if (pos < 0) return null; pos += 4; }
    for (let i = 0; i < an; i++) {
      pos = skipName(b, pos);
      if (pos < 0 || pos + 10 > b.length) break;
      const type = b.readUInt16BE(pos), rdlen = b.readUInt16BE(pos + 8), rd = pos + 10;
      if (rd + rdlen > b.length) break;
      if (type === 1 && rdlen === 4) {
        const to = map.get(`${b[rd]}.${b[rd + 1]}.${b[rd + 2]}.${b[rd + 3]}`);
        if (to) {
          out ??= Buffer.from(b);
          to.split('.').forEach((o, k) => { out![rd + k] = Number(o); });
        }
      }
      pos = rd + rdlen;
    }
    return out;
  } catch {
    return null;
  }
}

/** Ответ «не влезло, повторите по TCP»: заголовок + вопрос с флагом TC */
export function truncated(resp: Buffer, q: Question): Buffer {
  const out = Buffer.from(resp.subarray(0, q.end));
  out[2] |= 0x02; // TC
  out.writeUInt16BE(1, 4);
  out.writeUInt32BE(0, 6); // an=0, ns=0
  out.writeUInt16BE(0, 10); // ar=0
  return out;
}

/** SERVFAIL на запрос (когда не ответил ни DoH, ни запасной DNS) */
export function servfail(query: Buffer): Buffer {
  const q = parseQuestion(query);
  const out = Buffer.from(query.subarray(0, q ? q.end : 12));
  out[2] = (out[2] | 0x80) & ~0x02; // QR=1
  out[3] = (out[3] & 0xf0) | 2; // RCODE=SERVFAIL
  out.writeUInt16BE(q ? 1 : 0, 4);
  out.writeUInt32BE(0, 6);
  out.writeUInt16BE(0, 10);
  return out;
}

/** Все A-записи ответа (для поиска заглушек) */
export function aRecords(b: Buffer): string[] {
  const out: string[] = [];
  try {
    const qd = b.readUInt16BE(4), an = b.readUInt16BE(6);
    let pos = 12;
    for (let i = 0; i < qd; i++) { pos = skipName(b, pos); if (pos < 0) return out; pos += 4; }
    for (let i = 0; i < an; i++) {
      pos = skipName(b, pos);
      if (pos < 0 || pos + 10 > b.length) break;
      const type = b.readUInt16BE(pos), rdlen = b.readUInt16BE(pos + 8), rd = pos + 10;
      if (type === 1 && rdlen === 4 && rd + 4 <= b.length) out.push(`${b[rd]}.${b[rd + 1]}.${b[rd + 2]}.${b[rd + 3]}`);
      pos = rd + rdlen;
    }
  } catch { /* битый ответ */ }
  return out;
}
