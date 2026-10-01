// Клиент Telegram-релея: мультиплексированный TCP поверх WebSocket, протокол z2k v1
// (AUTH 0x00 = HMAC общего секрета, CONNECT/DATA/CLOSE/CONNECT_OK/CONNECT_FAIL).
// На нём говорят и наш Cloudflare Worker (resources/cf-worker/worker.js), и релей z2k с VPS (vps-relay/).
// Workers ограничивают число одновременных исходящих соединений и подзапросов на один запрос,
// поэтому для Worker потоки раскладываются по нескольким WebSocket-сессиям: в каждой не больше
// 5 одновременных и 40 за жизнь сессии (z2k ротировал WS после 40 CONNECT). У релея на VPS таких лимитов нет.
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import WebSocket from 'ws';

const AUTH = 0x00, CONNECT = 0x01, DATA = 0x02, CLOSE = 0x03, CONNECT_OK = 0x04, CONNECT_FAIL = 0x05;
const CHUNK = 16 * 1024;

export interface PoolLimits {
  name: string; // для сообщений об ошибках
  maxActive: number; // одновременных потоков на сессию
  maxTotal: number; // потоков за жизнь сессии
}

export const CF_LIMITS: PoolLimits = { name: 'Worker', maxActive: 5, maxTotal: 40 };
// Релей z2k: до 512 потоков на сессию (--max-streams-per-session) и 64 дозвона одновременно
export const RELAY_LIMITS: PoolLimits = { name: 'Релей', maxActive: 48, maxTotal: Infinity };

export class CfStream extends EventEmitter {
  closed = false;
  constructor(private readonly session: Session, readonly id: number) {
    super();
  }
  write(buf: Buffer) {
    for (let i = 0; i < buf.length; i += CHUNK) this.session.send(this.id, DATA, buf.subarray(i, i + CHUNK));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.session.send(this.id, CLOSE);
    this.session.release(this.id);
    this.emit('close');
  }
  /** закрыто с той стороны */
  remoteClosed() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

function frame(id: number, type: number, payload?: Buffer) {
  const h = Buffer.from([(id >> 8) & 0xff, id & 0xff, type]);
  return payload?.length ? Buffer.concat([h, payload]) : h;
}

function encodeTarget(host: string, port: number): Buffer {
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  if (net.isIPv4(host)) return Buffer.concat([Buffer.from([1, ...host.split('.').map(Number)]), p]);
  const full = expandV6(host);
  const b = Buffer.alloc(16);
  full.forEach((g, i) => b.writeUInt16BE(g, i * 2));
  return Buffer.concat([Buffer.from([4]), b, p]);
}

function expandV6(ip: string): number[] {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const zeros = new Array(8 - h.length - t.length).fill('0');
  return [...h, ...(tail !== undefined ? zeros : []), ...t].map((x) => parseInt(x || '0', 16));
}

class Session {
  ws: WebSocket;
  ready: Promise<void>;
  streams = new Map<number, CfStream>();
  pending = new Map<number, { resolve: (s: CfStream) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  total = 0;
  private nextId = 1;
  dead = false;

  constructor(url: string, secret: string, private readonly limits: PoolLimits, private readonly onDead: (s: Session) => void) {
    this.ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 10_000, family: 4 } as WebSocket.ClientOptions);
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', () => {
        // AUTH: HMAC-SHA256 секрета, ключ — сам секрет (как в z2k)
        this.ws.send(frame(0, AUTH, createHmac('sha256', secret).update(secret).digest()));
        resolve();
      });
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (_q, res) => reject(new Error(`${limits.name} ответил HTTP ${res.statusCode}`)));
    });
    this.ready.catch(() => this.kill('connect failed'));
    this.ws.on('message', (data: WebSocket.RawData) => this.onMessage(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)));
    this.ws.on('close', (code, reason) => this.kill(`закрыто ${code} ${reason.toString()}`));
    this.ws.on('error', () => undefined);
    // keepalive: без трафика Cloudflare закрывает простаивающий WS, а релей z2k — через 90 с тишины
    const ping = setInterval(() => { if (this.ws.readyState === WebSocket.OPEN) this.ws.ping(); }, 30_000);
    this.ws.once('close', () => clearInterval(ping));
  }

  usable() {
    return !this.dead && this.total < this.limits.maxTotal && this.streams.size + this.pending.size < this.limits.maxActive;
  }

  send(id: number, type: number, payload?: Buffer) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame(id, type, payload));
  }

  release(id: number) {
    this.streams.delete(id);
    // исчерпанную сессию без потоков закрываем
    if (this.total >= this.limits.maxTotal && this.streams.size === 0 && this.pending.size === 0) this.ws.close();
  }

  async open(host: string, port: number): Promise<CfStream> {
    await this.ready;
    let id = this.nextId;
    while (this.streams.has(id) || this.pending.has(id)) id = (id % 65535) + 1;
    this.nextId = (id % 65535) + 1;
    this.total++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.limits.name} не ответил на CONNECT`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send(id, CONNECT, encodeTarget(host, port));
    });
  }

  private onMessage(b: Buffer) {
    if (b.length < 3) return;
    const id = b.readUInt16BE(0);
    const type = b[2];
    const payload = b.subarray(3);
    const p = this.pending.get(id);
    if (type === CONNECT_OK && p) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      const s = new CfStream(this, id);
      this.streams.set(id, s);
      p.resolve(s);
    } else if (type === CONNECT_FAIL && p) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error(`${this.limits.name} не смог подключиться к DC`));
      this.release(id);
    } else if (type === DATA) {
      this.streams.get(id)?.emit('data', payload);
    } else if (type === CLOSE) {
      const s = this.streams.get(id);
      this.release(id);
      s?.remoteClosed();
    }
  }

  kill(reason: string) {
    if (this.dead) return;
    this.dead = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
    for (const s of this.streams.values()) s.remoteClosed();
    this.streams.clear();
    try { this.ws.terminate(); } catch { /* уже закрыт */ }
    this.onDead(this);
  }
}

export class CfWorkerPool {
  private sessions: Session[] = [];
  constructor(private readonly url: string, private readonly secret: string, private readonly limits: PoolLimits = CF_LIMITS) {}

  async open(host: string, port: number): Promise<CfStream> {
    let s = this.sessions.find((x) => x.usable());
    if (!s) {
      s = new Session(this.url, this.secret, this.limits, (dead) => { this.sessions = this.sessions.filter((x) => x !== dead); });
      this.sessions.push(s);
    }
    return s.open(host, port);
  }

  sessionCount() {
    return this.sessions.length;
  }

  close() {
    for (const s of [...this.sessions]) s.kill('stop');
    this.sessions = [];
  }
}

/** URL вида https://name.sub.workers.dev или 1.2.3.4.nip.io → wss://…/ws */
export function normalizeWorkerUrl(u: string): string {
  let s = u.trim();
  if (!s) return s;
  if (!/^[a-z]+:\/\//i.test(s)) s = 'wss://' + s;
  const url = new URL(s);
  url.protocol = url.protocol === 'http:' || url.protocol === 'ws:' ? 'ws:' : 'wss:';
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws';
  return url.toString();
}
