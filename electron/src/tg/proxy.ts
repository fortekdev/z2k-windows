// Локальный Telegram-прокси (SOCKS5).
// Telegram Desktop подключается к 127.0.0.1:<port> как к SOCKS5 и просит соединение с IP дата-центра.
// Режим «ws»: по первым 64 байтам (obfuscated2) определяем DC и ведём трафик через WebSocket самого Telegram
// (wss://kwsN.web.telegram.org/apiws, media — kwsN-1), который провайдеры, как правило, не режут.
// Режимы «cfworker» и «relay»: туннель до своего Cloudflare Worker или своего VPS с релеем z2k (vps-relay/),
// а уже они соединяются с исходным IP:порт дата-центра — нужен, когда Telegram заблокирован по IP целиком.
// Режим «direct»: прямой TCP до DC (обход DPI — на совести winws2).
// Режим «warp»: тоже прямой TCP, но подсети Telegram заворачиваются маршрутами в туннель WARP (warp/manager.ts).
// Прозрачный режим (tg/redirect.ts): то же самое для программ без настроек прокси — их соединения к подсетям
// Telegram перехватываются WinDivert'ом и приходят сюда как обычные SOCKS5 CONNECT.
import net from 'node:net';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { TgDcStat, TgSettings, TgState } from '../../../shared/types';
import { log } from '../logger';
import { PacketSplitter, parseInit } from './obfs';
import { CfWorkerPool, normalizeWorkerUrl, RELAY_LIMITS } from './cfworker';
import { tgRedirect } from './redirect';

// Подсети Telegram (core.telegram.org/resources/cidr.txt + 95.161.64.0/20 из z2k)
const TG_V4: [string, number][] = [
  ['91.108.4.0', 22], ['91.108.8.0', 22], ['91.108.12.0', 22], ['91.108.16.0', 22], ['91.108.20.0', 22],
  ['91.108.56.0', 22], ['91.105.192.0', 23], ['149.154.160.0', 20], ['185.76.151.0', 24], ['95.161.64.0', 20],
];
const TG_V6 = ['2001:b28:f23c:', '2001:b28:f23d:', '2001:b28:f23f:', '2001:67c:4e8:', '2a0a:f280:'];
// Те же подсети в CIDR — для прозрачного перехвата (z2k-tgredir)
export const TG_CIDRS = [
  ...TG_V4.map(([base, bits]) => `${base}/${bits}`),
  '2001:b28:f23c::/48', '2001:b28:f23d::/48', '2001:b28:f23f::/48', '2001:67c:4e8::/48', '2a0a:f280::/32',
];

// Известные адреса DC → номер (на случай, если init не разобрался)
const IP_DC: Record<string, number> = {
  '149.154.175.50': 1, '149.154.175.51': 1, '149.154.175.53': 1, '149.154.175.54': 1, '149.154.175.52': 1, '149.154.175.211': 1,
  '149.154.167.41': 2, '149.154.167.50': 2, '149.154.167.51': 2, '149.154.167.220': 2, '95.161.76.100': 2, '149.154.167.151': 2, '149.154.167.222': 2, '149.154.167.223': 2, '149.154.162.123': 2,
  '149.154.175.100': 3, '149.154.175.101': 3,
  '149.154.167.91': 4, '149.154.167.92': 4, '149.154.164.250': 4, '149.154.166.120': 4, '149.154.166.121': 4, '149.154.167.118': 4, '149.154.165.111': 4,
  '91.108.56.100': 5, '91.108.56.101': 5, '91.108.56.116': 5, '91.108.56.126': 5, '149.154.171.5': 5, '91.108.56.102': 5, '91.108.56.128': 5, '91.108.56.151': 5,
  '91.105.192.100': 203,
};

function ipv4ToInt(ip: string) {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}

export function isTelegramIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const v = ipv4ToInt(ip);
    return TG_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (v & mask) === (ipv4ToInt(base) & mask);
    });
  }
  const low = ip.toLowerCase();
  return TG_V6.some((p) => low.startsWith(p));
}

function wsHost(dc: number): string | null {
  const n = Math.abs(dc);
  if (n < 1 || n > 5) return null;
  return dc < 0 ? `kws${n}-1.web.telegram.org` : `kws${n}.web.telegram.org`;
}

interface DcCounters { active: number; total: number; up: number; down: number; lastError: string | null }

export class TgProxy extends EventEmitter {
  private server: net.Server | null = null;
  private cfg: TgSettings | null = null;
  private sockets = new Set<net.Socket>();
  private dcs = new Map<string, DcCounters>();
  private totals = { connections: 0, total: 0, up: 0, down: 0 };
  private lastError: string | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  private cf: CfWorkerPool | null = null;

  constructor() {
    super();
    tgRedirect.on('state', () => this.changed());
  }

  state(): TgState {
    const dcs: TgDcStat[] = [...this.dcs.entries()]
      .map(([dc, c]) => ({ dc, active: c.active, total: c.total, bytesUp: c.up, bytesDown: c.down, lastError: c.lastError }))
      .sort((a, b) => a.dc.localeCompare(b.dc));
    return {
      running: !!this.server?.listening,
      listen: this.server?.listening && this.cfg ? `${this.cfg.host}:${this.cfg.port}` : null,
      mode: this.cfg?.mode ?? 'ws',
      connections: this.totals.connections,
      totalConnections: this.totals.total,
      bytesUp: this.totals.up,
      bytesDown: this.totals.down,
      dcs,
      lastError: this.lastError,
      transparent: tgRedirect.state,
    };
  }

  private changed() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('state', this.state());
    }, 500);
  }

  async start(cfg: TgSettings): Promise<TgState> {
    await this.stop();
    this.cfg = cfg;
    this.lastError = null;
    const listen = (port: number) => new Promise<net.Server>((resolve, reject) => {
      const srv = net.createServer((sock) => this.onClient(sock));
      srv.maxConnections = 512;
      srv.once('error', reject);
      srv.listen(port, cfg.host, () => resolve(srv));
    });
    let server: net.Server;
    try {
      server = await listen(cfg.port);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // EACCES — порт в диапазоне, зарезервированном Windows (Hyper-V/WSL/Docker, winnat); EADDRINUSE — занят.
      // Подбираем свободный порт вне резервов и сообщаем, чтобы настройки и ссылка для Telegram обновились.
      const alt = err.code === 'EACCES' || err.code === 'EADDRINUSE' ? await pickFreePort(cfg.host, cfg.port) : null;
      if (!alt) {
        this.lastError = `Не удалось открыть ${cfg.host}:${cfg.port}: ${err.message}`;
        log.error('tg', this.lastError);
        this.changed();
        throw e;
      }
      server = await listen(alt);
      log.warn('tg', `Порт ${cfg.port} ${err.code === 'EACCES' ? 'зарезервирован Windows (Hyper-V/WSL)' : 'занят'} — прокси переехал на ${alt}`);
      cfg = { ...cfg, port: alt };
      this.cfg = cfg;
      this.emit('port-changed', alt);
    }
    server.on('error', (e) => log.error('tg', e.message));
    this.server = server;
    if (cfg.mode === 'cfworker') {
      if (!cfg.cfWorkerUrl || !cfg.cfWorkerSecret) log.warn('tg', 'Режим Cloudflare Worker: не задан адрес или секрет релея');
      else this.cf = new CfWorkerPool(normalizeWorkerUrl(cfg.cfWorkerUrl), cfg.cfWorkerSecret);
    } else if (cfg.mode === 'relay') {
      if (!cfg.relayUrl || !cfg.relaySecret) log.warn('tg', 'Свой VPS-релей: не задан адрес или секрет');
      else this.cf = new CfWorkerPool(normalizeWorkerUrl(cfg.relayUrl), cfg.relaySecret, RELAY_LIMITS);
    }
    const modeText = { ws: 'WebSocket Telegram', warp: 'через WARP', cfworker: 'Cloudflare Worker', relay: 'свой VPS-релей', direct: 'прямой' }[cfg.mode];
    log.info('tg', `Telegram-прокси SOCKS5 слушает ${cfg.host}:${cfg.port} (режим: ${modeText})`);
    // В режиме WARP подсети Telegram и так идут в туннель системными маршрутами — для всех программ и с UDP
    if (cfg.transparent && cfg.mode !== 'warp') {
      await tgRedirect.start({ socksPort: cfg.port, auth: cfg.auth.enabled ? { user: cfg.auth.user, pass: cfg.auth.pass } : null, nets: TG_CIDRS });
    }
    this.changed();
    return this.state();
  }

  async stop(): Promise<void> {
    await tgRedirect.stop();
    const s = this.server;
    this.server = null;
    this.cf?.close();
    this.cf = null;
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
    if (s) {
      await new Promise<void>((r) => s.close(() => r()));
      log.info('tg', 'Telegram-прокси остановлен');
    }
    this.totals.connections = 0;
    for (const c of this.dcs.values()) c.active = 0;
    this.changed();
  }

  private counters(dc: string): DcCounters {
    let c = this.dcs.get(dc);
    if (!c) this.dcs.set(dc, (c = { active: 0, total: 0, up: 0, down: 0, lastError: null }));
    return c;
  }

  // ---------- SOCKS5 ----------

  private onClient(sock: net.Socket) {
    this.sockets.add(sock);
    sock.setNoDelay(true);
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => sock.destroy());
    void this.handshake(sock).catch((e: Error) => {
      log.debug('tg', `SOCKS: ${e.message}`);
      sock.destroy();
    });
  }

  private async handshake(sock: net.Socket) {
    const cfg = this.cfg!;
    const reader = new SockReader(sock);
    const [ver, nmethods] = await reader.read(2);
    if (ver !== 5) throw new Error(`не SOCKS5 (ver=${ver})`);
    const methods = await reader.read(nmethods);
    if (cfg.auth.enabled) {
      if (!methods.includes(2)) { sock.end(Buffer.from([5, 0xff])); return; }
      sock.write(Buffer.from([5, 2]));
      const [, ulen] = await reader.read(2);
      const user = (await reader.read(ulen)).toString();
      const [plen] = await reader.read(1);
      const pass = (await reader.read(plen)).toString();
      const ok = user === cfg.auth.user && pass === cfg.auth.pass;
      sock.write(Buffer.from([1, ok ? 0 : 1]));
      if (!ok) { sock.end(); return; }
    } else {
      if (!methods.includes(0)) { sock.end(Buffer.from([5, 0xff])); return; }
      sock.write(Buffer.from([5, 0]));
    }
    const [, cmd, , atyp] = await reader.read(4);
    let host: string;
    if (atyp === 1) host = [...(await reader.read(4))].join('.');
    else if (atyp === 4) {
      const b = await reader.read(16);
      host = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(':');
    } else if (atyp === 3) {
      const [len] = await reader.read(1);
      host = (await reader.read(len)).toString();
    } else throw new Error(`atyp ${atyp}`);
    const port = (await reader.read(2)).readUInt16BE(0);
    if (cmd !== 1) {
      sock.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
      return;
    }
    // Отвечаем сразу: для выбора маршрута нужен init клиента, а он придёт только после ответа
    sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
    const early = reader.drain();
    await this.route(sock, host, port, early);
  }

  // ---------- маршрутизация ----------

  private async route(sock: net.Socket, host: string, port: number, early: Buffer) {
    const cfg = this.cfg!;
    const tg = net.isIP(host) ? isTelegramIp(host) : false;
    if (tg && (cfg.mode === 'cfworker' || cfg.mode === 'relay') && this.cf) {
      await this.pipeCf(sock, host, port, early);
      return;
    }
    if (!tg || cfg.mode !== 'ws') {
      this.pipeDirect(sock, host, port, early, tg ? `ip${host}` : 'other');
      return;
    }
    // Ждём 64 байта init
    let head = early;
    if (head.length < 64) {
      head = await new Promise<Buffer>((resolve) => {
        const chunks = [head];
        let len = head.length;
        const onData = (d: Buffer) => {
          chunks.push(d);
          len += d.length;
          if (len >= 64) { cleanup(); resolve(Buffer.concat(chunks)); }
        };
        const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
        const timer = setTimeout(onEnd, 15_000);
        const cleanup = () => { clearTimeout(timer); sock.off('data', onData); sock.off('end', onEnd); sock.pause(); };
        sock.on('data', onData);
        sock.on('end', onEnd);
        sock.resume();
      });
    }
    const init = parseInit(head);
    const dc = init?.dc ?? IP_DC[host] ?? 0;
    const hostWs = init ? wsHost(dc) : null;
    if (!init || !hostWs) {
      // HTTP-транспорт, CDN-DC (203) и прочее — напрямую
      this.pipeDirect(sock, host, port, head, init ? `dc${dc}` : 'raw');
      return;
    }
    const label = dc < 0 ? `${-dc}m` : String(dc);
    try {
      await this.pipeWs(sock, hostWs, label, head, init);
    } catch (e) {
      const msg = (e as Error).message;
      this.counters(label).lastError = msg;
      log.warn('tg', `DC${label}: WebSocket недоступен (${msg})${cfg.wsFallbackDirect ? ' — пробую напрямую' : ''}`);
      if (cfg.wsFallbackDirect && !sock.destroyed) this.pipeDirect(sock, host, port, head, label);
      else sock.destroy();
    }
  }

  private track(label: string) {
    const c = this.counters(label);
    c.active++;
    c.total++;
    this.totals.connections++;
    this.totals.total++;
    this.changed();
    let closed = false;
    return {
      up: (n: number) => { c.up += n; this.totals.up += n; this.changed(); },
      down: (n: number) => { c.down += n; this.totals.down += n; this.changed(); },
      close: () => {
        if (closed) return;
        closed = true;
        c.active--;
        this.totals.connections--;
        this.changed();
      },
    };
  }

  /** Через свой Cloudflare Worker или VPS-релей: он сам соединяется с исходным IP:порт дата-центра */
  private async pipeCf(sock: net.Socket, host: string, port: number, early: Buffer) {
    const label = `${this.cfg?.mode === 'relay' ? 'relay' : 'cf'} ${IP_DC[host] ? 'DC' + IP_DC[host] : host}`;
    let stream;
    try {
      stream = await this.cf!.open(host, port);
    } catch (e) {
      const msg = (e as Error).message;
      this.counters(label).lastError = msg;
      log.warn('tg', `${label}: ${msg}`);
      sock.destroy();
      return;
    }
    const t = this.track(label);
    if (early.length) { stream.write(early); t.up(early.length); }
    sock.on('data', (d: Buffer) => { t.up(d.length); stream.write(d); });
    stream.on('data', (d: Buffer) => { t.down(d.length); sock.write(d); });
    const close = () => { t.close(); stream.close(); sock.destroy(); };
    stream.once('close', close);
    sock.once('close', close);
    sock.resume();
  }

  private pipeDirect(sock: net.Socket, host: string, port: number, head: Buffer, label: string) {
    const t = this.track(label);
    const up = net.connect({ host, port, noDelay: true });
    up.setTimeout(20_000, () => up.destroy(new Error('timeout')));
    up.once('connect', () => up.setTimeout(0));
    if (head.length) { up.write(head); t.up(head.length); }
    sock.on('data', (d) => { t.up(d.length); up.write(d); });
    up.on('data', (d) => { t.down(d.length); sock.write(d); });
    const close = () => { t.close(); sock.destroy(); up.destroy(); };
    up.on('error', (e) => { this.counters(label).lastError = e.message; close(); });
    up.on('close', close);
    sock.on('close', close);
    sock.resume();
  }

  private pipeWs(sock: net.Socket, host: string, label: string, head: Buffer, init: NonNullable<ReturnType<typeof parseInit>>) {
    const cfg = this.cfg!;
    return new Promise<void>((resolve, reject) => {
      const front = cfg.wsFrontIp.trim();
      const options: WebSocket.ClientOptions & { servername: string } = {
        servername: host,
        handshakeTimeout: 8000,
        perMessageDeflate: false,
        headers: { Origin: 'https://web.telegram.org', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' },
        // Подключаемся к фронту web.telegram.org по IP, имя — в SNI/Host
        ...(front ? { lookup: (_h: string, o: unknown, cb: (...a: unknown[]) => void) => ((o as { all?: boolean })?.all ? cb(null, [{ address: front, family: net.isIPv6(front) ? 6 : 4 }]) : cb(null, front, net.isIPv6(front) ? 6 : 4)) } : {}),
      } as WebSocket.ClientOptions & { servername: string };
      const ws = new WebSocket(`wss://${host}/apiws`, ['binary'], options);
      const pending: Buffer[] = [];
      const splitter = new PacketSplitter(init);
      // Всё, что пришло после init, режем на пакеты
      const afterInit = head.subarray(64);
      if (afterInit.length) pending.push(...splitter.push(afterInit));
      const onClientData = (d: Buffer) => {
        for (const p of splitter.push(d)) {
          if (ws.readyState === WebSocket.OPEN) ws.send(p);
          else pending.push(p);
        }
      };
      sock.on('data', onClientData);
      sock.pause();

      ws.once('open', () => {
        const t = this.track(label);
        resolve();
        ws.send(head.subarray(0, 64));
        t.up(head.length);
        for (const p of pending) ws.send(p);
        pending.length = 0;
        sock.on('data', (d) => t.up(d.length));
        sock.resume();
        ws.on('message', (data: WebSocket.RawData) => {
          const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
          t.down(buf.length);
          if (!sock.write(buf)) {
            ws.pause();
            sock.once('drain', () => ws.resume());
          }
        });
        const close = () => {
          t.close();
          sock.destroy();
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
        };
        ws.on('close', close);
        ws.on('error', (e) => { this.counters(label).lastError = e.message; close(); });
        sock.on('close', close);
      });
      ws.once('unexpected-response', (_req, res) => {
        sock.off('data', onClientData);
        reject(new Error(`HTTP ${res.statusCode}`));
      });
      ws.once('error', (e) => {
        if (ws.readyState !== WebSocket.OPEN) {
          sock.off('data', onClientData);
          reject(e);
        }
      });
    });
  }
}

/** Последовательное чтение N байт из сокета для разбора SOCKS */
class SockReader {
  private buf = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  private ended = false;
  private readonly onData = (d: Buffer) => {
    this.buf = Buffer.concat([this.buf, d]);
    this.waiters.splice(0).forEach((w) => w());
  };

  constructor(private readonly sock: net.Socket) {
    sock.on('data', this.onData);
    sock.once('end', () => { this.ended = true; this.waiters.splice(0).forEach((w) => w()); });
  }

  async read(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      if (this.ended) throw new Error('клиент закрыл соединение');
      await new Promise<void>((r) => this.waiters.push(r));
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Отдать недочитанное и отцепиться от сокета */
  drain(): Buffer {
    this.sock.off('data', this.onData);
    this.sock.pause();
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return rest;
  }
}

export const tgProxy = new TgProxy();

export function tgLink(cfg: TgSettings): string {
  const host = cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host;
  const q = new URLSearchParams({ server: host, port: String(cfg.port) });
  if (cfg.auth.enabled) { q.set('user', cfg.auth.user); q.set('pass', cfg.auth.pass); }
  return `tg://socks?${q.toString()}`;
}

// ---------- выбор порта ----------

/** Диапазоны портов, исключённые Windows (netsh … show excludedportrange) */
async function excludedRanges(): Promise<[number, number][]> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile('netsh', ['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve([]);
      const out: [number, number][] = [];
      for (const m of stdout.matchAll(/^\s*(\d+)\s+(\d+)/gm)) out.push([Number(m[1]), Number(m[2])]);
      resolve(out);
    });
  });
}

function canListen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

/** Свободный порт вне зарезервированных диапазонов: сначала привычные для прокси, затем соседние */
export async function pickFreePort(host: string, preferred: number): Promise<number | null> {
  const ranges = await excludedRanges();
  const reserved = (p: number) => ranges.some(([a, b]) => p >= a && p <= b);
  const candidates = [10808, 10809, 7890, 9150, 20808, 31080, 40808, ...Array.from({ length: 50 }, (_, i) => 18080 + i)];
  for (const p of candidates) {
    if (p === preferred || reserved(p)) continue;
    if (await canListen(host, p)) return p;
  }
  return null;
}
