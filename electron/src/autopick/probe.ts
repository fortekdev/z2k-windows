// Проба домена по стадиям DNS → TCP → TLS → HTTP (аналог z2k-detect probe).
// Ничего не меняет; используется в «Диагностике» и как оракул успеха в автоподборе.
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import type { ProbeResult, ProbeStage } from '../../../shared/types';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// Порталы-заглушки провайдеров (редирект на них = блокировка по HTTP)
const BLOCK_PORTALS = [/warning\.rt\.ru/i, /blocked\.mts\.ru/i, /zapret\.beeline/i, /\.rkn\.gov\.ru/i, /blocklist\./i, /block\.?page/i, /fz139/i, /eais\.rkn/i];

export interface ProbeOptions {
  ip?: string; // проверять конкретный адрес
  port?: number;
  http?: boolean; // порт 80 без TLS
  timeoutMs?: number;
  maxBytes?: number;
  dohCompare?: boolean;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what}: таймаут ${ms} мс`)), ms))]);
}

export async function resolveHost(host: string): Promise<string[]> {
  if (net.isIP(host)) return [host];
  const res = await withTimeout(dns.lookup(host, { all: true, family: 4 }), 5000, 'DNS');
  return [...new Set(res.map((r) => r.address))];
}

/** DNS через DoH Cloudflare по IP — для сравнения с системным (подмена DNS) */
export async function resolveDoh(host: string): Promise<string[]> {
  const r = await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=A`, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(5000),
  });
  const j = (await r.json()) as { Answer?: { type: number; data: string }[] };
  return (j.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
}

interface HttpOutcome {
  status: number | null;
  location: string | null;
  bytes: number;
  complete: boolean;
  stalled: boolean;
  ms: number;
  error: string | null;
}

/** Отправить GET и читать ответ, пока не закончится, не наберём maxBytes или не наступит тишина */
function httpExchange(sock: net.Socket | tls.TLSSocket, host: string, maxBytes: number, idleMs: number, totalMs: number): Promise<HttpOutcome> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let head = '';
    let bytes = 0;
    let status: number | null = null;
    let location: string | null = null;
    let contentLength: number | null = null;
    let bodyStart = -1;
    let done = false;
    const finish = (o: Partial<HttpOutcome>) => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      clearTimeout(total);
      sock.destroy();
      resolve({ status, location, bytes, complete: false, stalled: false, ms: Date.now() - t0, error: null, ...o });
    };
    let idle = setTimeout(() => finish({ stalled: true }), idleMs);
    const total = setTimeout(() => finish({ stalled: true }), totalMs);
    sock.on('data', (d: Buffer) => {
      bytes += d.length;
      clearTimeout(idle);
      idle = setTimeout(() => finish({ stalled: true }), idleMs);
      if (bodyStart < 0) {
        head += d.toString('latin1');
        const end = head.indexOf('\r\n\r\n');
        if (end >= 0) {
          bodyStart = end + 4;
          const m = head.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
          status = m ? Number(m[1]) : null;
          location = head.match(/\r\nlocation:\s*([^\r\n]+)/i)?.[1] ?? null;
          const cl = head.match(/\r\ncontent-length:\s*(\d+)/i);
          contentLength = cl ? Number(cl[1]) : null;
        }
      }
      if (contentLength !== null && bodyStart >= 0 && bytes - bodyStart >= contentLength) finish({ complete: true });
      else if (bytes >= maxBytes) finish({ complete: true });
    });
    sock.on('end', () => finish({ complete: true }));
    sock.on('error', (e) => finish({ error: e.message }));
    sock.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ${UA}\r\nAccept: text/html,*/*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`);
  });
}

export async function probe(hostInput: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const host = hostInput.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const port = opts.port ?? (opts.http ? 80 : 443);
  const timeout = opts.timeoutMs ?? 8000;
  const stages: ProbeResult['stages'] = [];
  const add = (stage: ProbeStage, ok: boolean, ms: number, detail: string) => stages.push({ stage, ok, ms, detail });
  const result = (verdict: ProbeResult['verdict'], verdictText: string, ips: string[], bytes = 0): ProbeResult => ({ host, ips, stages, verdict, verdictText, bytes, inLists: [] });

  // DNS
  let ips: string[] = [];
  let t = Date.now();
  try {
    ips = opts.ip ? [opts.ip] : await resolveHost(host);
    let detail = ips.join(', ');
    if (opts.dohCompare && !opts.ip) {
      try {
        const doh = await resolveDoh(host);
        if (doh.length && !doh.some((a) => ips.includes(a))) detail += ` (DoH: ${doh.slice(0, 3).join(', ')} — ответы не совпадают)`;
      } catch { /* DoH недоступен — не повод для вердикта */ }
    }
    add('dns', ips.length > 0, Date.now() - t, detail || 'нет адресов');
    if (!ips.length) return result('dns_blocked', 'Имя не резолвится', ips);
    if (ips.some((a) => a.startsWith('127.') || a === '0.0.0.0')) return result('dns_blocked', 'DNS вернул заглушку (подмена DNS)', ips);
  } catch (e) {
    add('dns', false, Date.now() - t, (e as Error).message);
    return result('dns_blocked', 'Имя не резолвится', ips);
  }
  const ip = ips[0];

  // TCP
  t = Date.now();
  let sock: net.Socket;
  try {
    sock = await withTimeout(new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ host: ip, port, noDelay: true });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    }), timeout, 'TCP');
    add('tcp', true, Date.now() - t, `${ip}:${port}`);
  } catch (e) {
    add('tcp', false, Date.now() - t, (e as Error).message);
    return result('tcp_blocked', 'Соединение не устанавливается (блокировка по IP или сервер недоступен)', ips);
  }

  // TLS
  let stream: net.Socket | tls.TLSSocket = sock;
  if (!opts.http) {
    t = Date.now();
    try {
      stream = await withTimeout(new Promise<tls.TLSSocket>((resolve, reject) => {
        const s = tls.connect({ socket: sock, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'], rejectUnauthorized: false });
        s.once('secureConnect', () => resolve(s));
        s.once('error', reject);
        s.once('close', () => reject(new Error('соединение закрыто во время рукопожатия')));
      }), timeout, 'TLS');
      const s = stream as tls.TLSSocket;
      const cert = s.getPeerCertificate();
      const authorized = s.authorized ? 'сертификат валиден' : `сертификат: ${s.authorizationError ?? 'не проверен'}`;
      add('tls', true, Date.now() - t, `${s.getProtocol()} · ${authorized}${cert?.subject?.CN ? ` · CN=${cert.subject.CN}` : ''}`);
    } catch (e) {
      sock.destroy();
      const msg = (e as Error).message;
      add('tls', false, Date.now() - t, msg);
      const reset = /ECONNRESET|socket hang up|закрыто/i.test(msg);
      return result('tls_blocked', reset ? 'TLS рвут (сброс после ClientHello) — похоже на DPI' : 'TLS не устанавливается (таймаут) — похоже на DPI', ips);
    }
  }

  // HTTP
  t = Date.now();
  const http = await httpExchange(stream, host, opts.maxBytes ?? 256 * 1024, 5000, timeout + 4000);
  const bytes = http.bytes;
  if (http.error && !http.bytes) {
    add('http', false, Date.now() - t, http.error);
    return result('http_blocked', 'Ответ не получен (соединение сброшено)', ips);
  }
  if (http.status === null) {
    add('http', false, Date.now() - t, http.stalled ? 'нет ответа' : 'неожиданный ответ');
    return result('http_blocked', 'Сервер не ответил на запрос', ips);
  }
  if (http.location && BLOCK_PORTALS.some((re) => re.test(http.location!))) {
    add('http', false, Date.now() - t, `${http.status} → ${http.location}`);
    return result('http_blocked', 'Редирект на страницу блокировки провайдера', ips, bytes);
  }
  // Обрыв на 16 КБ: пришли первые ~15–17 КБ и дальше тишина
  if (!http.complete && http.stalled && bytes >= 12_000 && bytes <= 24_000) {
    add('http', false, Date.now() - t, `HTTP ${http.status}, ${bytes} байт и тишина`);
    return result('cutoff16k', 'Обрыв на ~16 КБ: начало ответа приходит, дальше поток режут', ips, bytes);
  }
  add('http', true, Date.now() - t, `HTTP ${http.status}${http.location ? ` → ${http.location}` : ''} · ${bytes} байт${http.stalled ? ' (без завершения)' : ''}`);
  return result('ok', 'Доступен', ips, bytes);
}
