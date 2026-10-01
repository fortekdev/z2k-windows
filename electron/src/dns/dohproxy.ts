// Локальный DNS-прокси: 127.0.0.1:53 и [::1]:53 (UDP+TCP) → DNS-over-HTTPS (RFC 8484, POST application/dns-message).
// Пока работает обход, DNS сетевых адаптеров смотрит сюда (sysdns.ts). Здесь же — подмена заблокированных по IP
// адресов (карта dnsfix): трафик на loopback WinDivert не видит, поэтому Lua-подмена движка до него не дотянется.
// Адрес самого DoH-сервера разрешается через прежние DNS-серверы, иначе запрос ушёл бы сам в себя.
import dgram from 'node:dgram';
import net from 'node:net';
import https from 'node:https';
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import { log } from '../logger';
import { aRecords, clientUdpSize, minTtl, parseQuestion, rewriteA, servfail, truncated } from './dnsmsg';

export interface DohStats { running: boolean; url: string | null; queries: number; cached: number; dohErrors: number; fallbacks: number; stubbed: number; lastError: string | null }

const CACHE_MAX = 2000;
// Для ответов-заглушек российского резолвера: Cloudflare по IP (без собственного резолва)
const FOREIGN_DOH = new URL('https://1.1.1.1/dns-query');

/** В ответе есть A-заглушка блокировки: 127.0.0.0/8 или 0.0.0.0 */
function hasStubA(resp: Buffer) {
  return aRecords(resp).some((ip) => ip.startsWith('127.') || ip === '0.0.0.0');
}

export class DohProxy extends EventEmitter {
  private udp: dgram.Socket[] = [];
  private tcp: net.Server[] = [];
  private agent: https.Agent | null = null;
  private url: URL | null = null;
  private fallback: string[] = [];
  private cache = new Map<string, { resp: Buffer; until: number }>();
  private map = new Map<string, string>();
  stats: DohStats = { running: false, url: null, queries: 0, cached: 0, dohErrors: 0, fallbacks: 0, stubbed: 0, lastError: null };
  private directAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });

  /** Карта «заблокированный IP → рабочий IP» */
  setFixMap(m: Record<string, string>) {
    this.map = new Map(Object.entries(m));
    this.cache.clear();
  }

  async start(urlStr: string, fallbackServers: string[]) {
    await this.stop();
    this.url = new URL(urlStr);
    this.fallback = fallbackServers.filter((s) => s && s !== '127.0.0.1' && s !== '::1');
    const bootstrap = this.fallback.length ? this.fallback : ['1.1.1.1', '8.8.8.8'];
    const resolver = new dns.Resolver({ timeout: 3000, tries: 2 });
    resolver.setServers(bootstrap);
    // Адрес DoH-сервера — мимо системного DNS (который теперь мы сами)
    const lookup: net.LookupFunction = (host, opts, cb) => {
      resolver.resolve4(host, (err, addrs) => {
        if (err || !addrs?.length) return (cb as (e: Error | null, a: string, f: number) => void)(err ?? new Error('no address'), '', 4);
        if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, addrs.map((a) => ({ address: a, family: 4 })));
        else (cb as (e: null, a: string, f: number) => void)(null, addrs[0], 4);
      });
    };
    this.agent = new https.Agent({ keepAlive: true, maxSockets: 8, lookup });

    for (const [type, addr] of [['udp4', '127.0.0.1'], ['udp6', '::1']] as const) {
      const s = dgram.createSocket({ type });
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.bind(53, addr, () => { s.off('error', reject); resolve(); });
      }).catch((e: NodeJS.ErrnoException) => {
        if (addr === '127.0.0.1') throw new Error(`не удалось открыть ${addr}:53/udp: ${e.code ?? e.message}`);
        log.warn('diag', `DoH-прокси: ${addr}:53 недоступен (${e.code})`);
      });
      s.on('message', (msg, rinfo) => void this.onUdp(s, msg, rinfo));
      s.on('error', (e) => log.warn('diag', `DoH-прокси UDP: ${e.message}`));
      this.udp.push(s);
    }
    for (const addr of ['127.0.0.1', '::1']) {
      const srv = net.createServer((c) => this.onTcp(c));
      await new Promise<void>((resolve) => {
        srv.once('error', (e) => { log.warn('diag', `DoH-прокси TCP ${addr}:53: ${e.message}`); resolve(); });
        srv.listen(53, addr, () => resolve());
      });
      this.tcp.push(srv);
    }
    this.stats = { running: true, url: urlStr, queries: 0, cached: 0, dohErrors: 0, fallbacks: 0, stubbed: 0, lastError: null };
    // Прогрев: TLS к DoH-серверу устанавливается заранее, иначе первый запрос Windows не уложится в свой таймаут
    void this.doh(Buffer.from('000001000001000000000000076578616d706c6503636f6d0000010001', 'hex')).catch(() => undefined);
    log.info('diag', `DoH-прокси запущен: 127.0.0.1:53 → ${urlStr}${this.fallback.length ? ` (запасной DNS: ${this.fallback.join(', ')})` : ''}`);
  }

  async stop() {
    for (const s of this.udp) try { s.close(); } catch { /* уже закрыт */ }
    for (const s of this.tcp) await new Promise<void>((r) => s.close(() => r()));
    this.udp = [];
    this.tcp = [];
    this.agent?.destroy();
    this.agent = null;
    this.cache.clear();
    if (this.stats.running) log.info('diag', 'DoH-прокси остановлен');
    this.stats = { ...this.stats, running: false };
  }

  private async onUdp(s: dgram.Socket, msg: Buffer, rinfo: dgram.RemoteInfo) {
    const q = parseQuestion(msg);
    let resp = await this.resolve(msg);
    if (q && resp.length > clientUdpSize(msg)) resp = truncated(resp, q);
    s.send(resp, rinfo.port, rinfo.address);
  }

  private onTcp(c: net.Socket) {
    let buf = Buffer.alloc(0);
    c.setTimeout(15_000, () => c.destroy());
    c.on('error', () => c.destroy());
    c.on('data', async (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        const len = buf.readUInt16BE(0);
        const msg = buf.subarray(2, 2 + len);
        buf = buf.subarray(2 + len);
        const resp = await this.resolve(Buffer.from(msg));
        const hdr = Buffer.alloc(2);
        hdr.writeUInt16BE(resp.length);
        c.write(Buffer.concat([hdr, resp]));
      }
    });
  }

  /** Ответ на запрос: кэш → DoH → запасной DNS → SERVFAIL */
  async resolve(query: Buffer): Promise<Buffer> {
    this.stats.queries++;
    const q = parseQuestion(query);
    const key = q ? `${q.name}|${q.type}|${q.cls}` : null;
    const id = query.subarray(0, 2);
    if (key) {
      const hit = this.cache.get(key);
      if (hit && hit.until > Date.now()) {
        this.stats.cached++;
        const r = Buffer.from(hit.resp);
        id.copy(r, 0);
        return r;
      }
    }
    let resp = await this.doh(query).catch((e: Error) => {
      this.stats.dohErrors++;
      if (this.stats.lastError !== e.message) log.warn('diag', `DoH: ${e.message} — отвечаю через запасной DNS`);
      this.stats.lastError = e.message;
      return null;
    });
    if (!resp) {
      resp = await this.udpFallback(query);
      if (resp) this.stats.fallbacks++;
    }
    if (!resp) return servfail(query);
    // Российский резолвер для сайтов из реестра сам отдаёт заглушку (127.0.0.1 / 0.0.0.0) — переспрашиваем зарубежный DoH
    // ...а иногда на запрос IPv4 отдаёт только псевдоним (CNAME) без адреса — без IPv6 сайт тогда «не найден».
    // В обоих случаях переспрашиваем зарубежный DoH; подмена заблокированных адресов применяется к его ответу.
    const incompleteA = q?.type === 1 && (resp[3] & 0x0f) === 0 && resp.readUInt16BE(6) > 0 && aRecords(resp).length === 0;
    if (hasStubA(resp) || incompleteA) {
      const alt = await this.doh(query, FOREIGN_DOH).catch(() => null);
      if (alt && (alt[3] & 0x0f) === 0 && !hasStubA(alt) && aRecords(alt).length > 0) {
        resp = alt;
        this.stats.stubbed++;
      }
    }
    resp = rewriteA(resp, this.map) ?? resp;
    id.copy(resp, 0);
    if (key && (resp[3] & 0x0f) === 0) {
      const ttl = Math.min(minTtl(resp) ?? 60, 300);
      if (this.cache.size > CACHE_MAX) this.cache.clear();
      this.cache.set(key, { resp: Buffer.from(resp), until: Date.now() + ttl * 1000 });
    }
    return resp;
  }

  private doh(query: Buffer, target: URL = this.url!): Promise<Buffer> {
    const url = target;
    // Зарубежный DoH задан IP-адресом — ему не нужен резолв через свой агент
    const agent = net.isIP(url.hostname) ? this.directAgent : this.agent!;
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: 'POST', agent,
        headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message', 'content-length': query.length },
        timeout: 5000,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => (res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`HTTP ${res.statusCode}`))));
      });
      req.on('timeout', () => req.destroy(new Error('таймаут DoH')));
      req.on('error', reject);
      req.end(query);
    });
  }

  private udpFallback(query: Buffer): Promise<Buffer | null> {
    const server = this.fallback[0];
    if (!server) return Promise.resolve(null);
    return new Promise((resolve) => {
      const s = dgram.createSocket(net.isIPv6(server) ? 'udp6' : 'udp4');
      const t = setTimeout(() => { s.close(); resolve(null); }, 3000);
      s.on('message', (m) => { clearTimeout(t); s.close(); resolve(m); });
      s.on('error', () => { clearTimeout(t); s.close(); resolve(null); });
      s.send(query, 53, server);
    });
  }
}

export const dohProxy = new DohProxy();
