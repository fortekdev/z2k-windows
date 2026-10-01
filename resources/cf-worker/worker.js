// z2k-windows Telegram relay — Cloudflare Worker.
// Протокол z2k cf-worker (апрель 2026): мультиплексированный TCP поверх WebSocket.
//   кадр: [stream_id u16 BE][type u8][payload]
//   0x00 AUTH (stream 0, HMAC-SHA256(secret, key=secret), 32 байта) — первым сообщением
//   0x01 CONNECT [atype 1|4][addr 4|16][port u16 BE]   0x02 DATA   0x03 CLOSE
//   0x04 CONNECT_OK   0x05 CONNECT_FAIL
// Отличия от исходника z2k: CONNECT_OK только после реального socket.opened (без «зомби»-потоков)
// и разрешены лишь подсети Telegram — Worker не становится открытым прокси.
// Секрет — переменная окружения TUNNEL_SECRET (secret_text).

import { connect } from "cloudflare:sockets";

const AUTH = 0x00, CONNECT = 0x01, DATA = 0x02, CLOSE = 0x03, CONNECT_OK = 0x04, CONNECT_FAIL = 0x05;
const MAX_STREAMS = 32;
const OPEN_TIMEOUT_MS = 10000;

const TG_V4 = [
  ["91.108.4.0", 22], ["91.108.8.0", 22], ["91.108.12.0", 22], ["91.108.16.0", 22], ["91.108.20.0", 22],
  ["91.108.56.0", 22], ["91.105.192.0", 23], ["149.154.160.0", 20], ["185.76.151.0", 24], ["95.161.64.0", 20],
];
const TG_V6 = ["2001:b28:f23c:", "2001:b28:f23d:", "2001:b28:f23f:", "2001:67c:4e8:", "2a0a:f280:"];

const ip4int = (ip) => ip.split(".").reduce((a, o) => ((a << 8) + Number(o)) >>> 0, 0);
function allowed(addr, v6) {
  if (v6) return TG_V6.some((p) => addr.startsWith(p));
  const v = ip4int(addr);
  return TG_V4.some(([base, bits]) => {
    const mask = (~0 << (32 - bits)) >>> 0;
    return ((v & mask) >>> 0) === ((ip4int(base) & mask) >>> 0);
  });
}

function frame(id, type, payload) {
  const len = payload ? payload.byteLength : 0;
  const out = new Uint8Array(3 + len);
  out[0] = (id >> 8) & 0xff;
  out[1] = id & 0xff;
  out[2] = type;
  if (len) out.set(payload instanceof Uint8Array ? payload : new Uint8Array(payload), 3);
  return out;
}

function parseTarget(p) {
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  if (p[0] === 1 && p.byteLength >= 7) return { host: `${p[1]}.${p[2]}.${p[3]}.${p[4]}`, port: v.getUint16(5), v6: false };
  if (p[0] === 4 && p.byteLength >= 19) {
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(v.getUint16(1 + i * 2).toString(16));
    return { host: parts.join(":"), port: v.getUint16(17), v6: true };
  }
  return null;
}

async function hmacSelf(secret) {
  const k = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, k));
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") return new Response("z2k relay", { status: 200 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    if (!env.TUNNEL_SECRET) return new Response("TUNNEL_SECRET is not set", { status: 500 });

    const expected = await hmacSelf(env.TUNNEL_SECRET);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    const streams = new Map();
    let authed = false;
    const send = (id, type, payload) => { try { server.send(frame(id, type, payload)); } catch (_) {} };

    const closeStream = (id, notify) => {
      const s = streams.get(id);
      if (!s) return;
      streams.delete(id);
      try { s.writer.close(); } catch (_) {}
      try { s.socket.close(); } catch (_) {}
      if (notify) send(id, CLOSE);
    };

    async function open(id, payload) {
      const t = parseTarget(payload);
      if (!t || !allowed(t.host, t.v6) || streams.size >= MAX_STREAMS) return send(id, CONNECT_FAIL);
      let socket;
      try {
        socket = connect({ hostname: t.host, port: t.port });
        await Promise.race([socket.opened, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), OPEN_TIMEOUT_MS))]);
      } catch (_) {
        try { socket && socket.close(); } catch (_) {}
        return send(id, CONNECT_FAIL);
      }
      const writer = socket.writable.getWriter();
      streams.set(id, { socket, writer });
      send(id, CONNECT_OK);
      try {
        const reader = socket.readable.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength) send(id, DATA, value);
        }
      } catch (_) {}
      if (streams.has(id)) closeStream(id, true);
    }

    server.addEventListener("message", async (ev) => {
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data instanceof Blob ? new Uint8Array(await ev.data.arrayBuffer()) : null;
      if (!buf || buf.byteLength < 3) return;
      const id = (buf[0] << 8) | buf[1];
      const type = buf[2];
      const payload = buf.subarray(3);
      if (!authed) {
        if (id === 0 && type === AUTH && equal(payload, expected)) { authed = true; return; }
        server.close(4002, "auth failed");
        return;
      }
      if (type === CONNECT) open(id, payload);
      else if (type === DATA) {
        const s = streams.get(id);
        if (s) s.writer.write(payload).catch(() => closeStream(id, true));
      } else if (type === CLOSE) closeStream(id, false);
    });
    const cleanup = () => { for (const id of [...streams.keys()]) closeStream(id, false); };
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    return new Response(null, { status: 101, webSocket: client });
  },
};
