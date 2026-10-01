// Самопроверка Telegram-прокси: как клиент Telegram — SOCKS5 → obfuscated2 → req_pq_multi, ждём resPQ от DC
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { makeClientInit } from './obfs';

export const DC_IP: Record<number, string> = { 1: '149.154.175.50', 2: '149.154.167.51', 3: '149.154.175.100', 4: '149.154.167.91', 5: '91.108.56.130' };

export interface DcProbe { dc: number; ok: boolean; ms: number; detail: string }

export function probeDc(port: number, dc: number, host = '127.0.0.1', auth?: { user: string; pass: string }): Promise<DcProbe> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    const finish = (ok: boolean, detail: string) => { s.destroy(); resolve({ dc, ok, ms: Date.now() - t0, detail }); };
    s.setTimeout(15000, () => finish(false, 'таймаут'));
    const { wire, encryptor, decryptor } = makeClientInit(dc);
    let stage = 0;
    let buf = Buffer.alloc(0);
    const sendConnect = () => {
      const ip = DC_IP[Math.abs(dc)].split('.').map(Number);
      s.write(Buffer.from([5, 1, 0, 1, ...ip, 0x01, 0xbb]));
      stage = 2;
    };
    s.on('connect', () => s.write(Buffer.from(auth ? [5, 1, 2] : [5, 1, 0])));
    s.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2) {
        const method = buf[1];
        buf = buf.subarray(2);
        if (method === 2 && auth) {
          const u = Buffer.from(auth.user), p = Buffer.from(auth.pass);
          s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
          stage = 1;
        } else if (method === 0) sendConnect();
        else return finish(false, 'прокси отклонил метод аутентификации');
      }
      if (stage === 1 && buf.length >= 2) {
        if (buf[1] !== 0) return finish(false, 'неверный логин/пароль');
        buf = buf.subarray(2);
        sendConnect();
      }
      if (stage === 2 && buf.length >= 10) {
        if (buf[1] !== 0) return finish(false, `SOCKS ответ ${buf[1]}`);
        buf = buf.subarray(10);
        stage = 3;
        const body = Buffer.concat([Buffer.from('f18e7ebe', 'hex'), randomBytes(16)]); // req_pq_multi
        const msg = Buffer.alloc(20);
        msg.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000)) << 32n, 8);
        msg.writeUInt32LE(body.length, 16);
        const payload = Buffer.concat([msg, body]);
        const len = Buffer.alloc(4);
        len.writeUInt32LE(payload.length);
        s.write(Buffer.concat([wire, encryptor.update(Buffer.concat([len, payload]))]));
      }
      if (stage === 3 && buf.length >= 28) {
        const dec = decryptor.update(buf);
        buf = Buffer.alloc(0);
        if (dec.readUInt32LE(0) === 4) return finish(false, `ошибка транспорта ${dec.readInt32LE(4)}`);
        const ok = dec.readUInt32LE(24) === 0x05162463;
        finish(ok, ok ? 'resPQ получен' : 'неожиданный ответ');
      }
    });
    s.on('error', (e) => finish(false, e.message));
    s.on('close', () => finish(false, 'прокси закрыл соединение'));
  });
}
