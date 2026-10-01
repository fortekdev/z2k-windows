// Клиент релея против макета z2k-vps-relay в режиме v1 (vps-relay/handshake.go, proto.go, session.go):
// первый кадр — AUTH 0x00 с HMAC-SHA256(secret, secret), иначе соединение рвётся; CONNECT [atyp][addr][port] →
// CONNECT_OK/CONNECT_FAIL без полезной нагрузки; DATA и CLOSE без причин.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { CfWorkerPool, RELAY_LIMITS } from '../src/tg/cfworker';

const SECRET = 'test-secret';

function frame(id: number, type: number, payload?: Buffer) {
  const h = Buffer.from([(id >> 8) & 0xff, id & 0xff, type]);
  return payload?.length ? Buffer.concat([h, payload]) : h;
}

/** Макет релея v1: пускает только на 127.0.0.1 (вместо подсетей Telegram) */
async function mockRelay() {
  const wss = new WebSocketServer({ port: 0, path: '/ws' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.on('connection', (ws) => {
    let authed = false;
    const ups = new Map<number, net.Socket>();
    ws.on('message', (raw: Buffer) => {
      const id = raw.readUInt16BE(0);
      const type = raw[2];
      const p = raw.subarray(3);
      if (!authed) {
        if (id !== 0 || type !== 0 || !p.equals(createHmac('sha256', SECRET).update(SECRET).digest())) return ws.terminate();
        authed = true;
        return;
      }
      if (type === 1) {
        const host = `${p[1]}.${p[2]}.${p[3]}.${p[4]}`;
        const port = p.readUInt16BE(5);
        if (p[0] !== 1 || host !== '127.0.0.1') return ws.send(frame(id, 5));
        const up = net.connect(port, host);
        up.once('connect', () => { ups.set(id, up); ws.send(frame(id, 4)); });
        up.once('error', () => ws.send(frame(id, 5)));
        up.on('data', (d: Buffer) => ws.send(frame(id, 2, d)));
        up.on('close', () => { if (ups.delete(id)) ws.send(frame(id, 3)); });
      } else if (type === 2) ups.get(id)?.write(p);
      else if (type === 3) { ups.get(id)?.destroy(); ups.delete(id); }
    });
  });
  return { wss, url: `ws://127.0.0.1:${(wss.address() as net.AddressInfo).port}/ws` };
}

test('релей z2k v1: авторизация, CONNECT, эхо данных, отказ по адресату и по секрету', async () => {
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
  const echoPort = (echo.address() as net.AddressInfo).port;
  const { wss, url } = await mockRelay();
  const pool = new CfWorkerPool(url, SECRET, RELAY_LIMITS);
  const bad = new CfWorkerPool(url, 'wrong', RELAY_LIMITS);
  try {
    const st = await pool.open('127.0.0.1', echoPort);
    const got = new Promise<string>((r) => st.once('data', (d: Buffer) => r(d.toString())));
    st.write(Buffer.from('ping'));
    assert.equal(await got, 'ping');
    // потоков больше, чем 5 у Worker, — в одной сессии
    const many = await Promise.all(Array.from({ length: 12 }, () => pool.open('127.0.0.1', echoPort)));
    assert.equal(pool.sessionCount(), 1);
    many.forEach((s) => s.close());
    st.close();

    await assert.rejects(pool.open('8.8.8.8', 443), /Релей не смог подключиться к DC/);
    await assert.rejects(bad.open('127.0.0.1', echoPort)); // релей рвёт сессию с неверным секретом
  } finally {
    pool.close();
    bad.close();
    wss.close();
    echo.close();
  }
});
