// Системные проверки и исправления Windows
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { SystemCheck } from '../../shared/types';
import { res } from './paths';
import { engine, listForeignEngines, winwsVersion } from './engine/winws';
import { log } from './logger';
import { detectMetaBlocks, dnsFixState } from './engine/metapins';
import { dohState } from './dns/doh';

const pexec = promisify(execFile);

async function ps(script: string, timeout = 15000): Promise<string> {
  const { stdout } = await pexec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout });
  return stdout.trim();
}

let adminCache: boolean | null = null;
export async function isAdmin(): Promise<boolean> {
  if (adminCache !== null) return adminCache;
  try {
    await pexec('net', ['session'], { windowsHide: true });
    adminCache = true;
  } catch {
    adminCache = false;
  }
  return adminCache;
}

// ---------- метки времени TCP ----------
// README z2k: часть стратегий портит timestamp в фейке, чтобы сервер его отбросил; в Windows метки выключены
// по умолчанию, сервер принимает подделку — и соединение виснет.

export async function tcpTimestamps(): Promise<boolean | null> {
  try {
    const out = await ps("(Get-NetTCPSetting -SettingName Internet).Timestamps");
    return /enabled/i.test(out);
  } catch {
    return null;
  }
}

export async function setTcpTimestamps(on: boolean) {
  await pexec('netsh', ['interface', 'tcp', 'set', 'global', `timestamps=${on ? 'enabled' : 'disabled'}`], { windowsHide: true });
  log.info('diag', `Метки времени TCP ${on ? 'включены' : 'выключены'}`);
}


// ---------- автозапуск (планировщик заданий: от администратора, без UAC при входе) ----------

const TASK = 'z2k-windows';

export async function autostartEnabled(): Promise<boolean> {
  try {
    await pexec('schtasks', ['/Query', '/TN', TASK], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export async function setAutostart(on: boolean) {
  if (!on) {
    await pexec('schtasks', ['/Delete', '/TN', TASK, '/F'], { windowsHide: true }).catch(() => undefined);
    return;
  }
  const exe = process.execPath;
  const args = app.isPackaged ? '--autostart' : `"${app.getAppPath()}" --autostart`;
  await pexec('schtasks', ['/Create', '/TN', TASK, '/TR', `"${exe}" ${args}`, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F', '/DELAY', '0000:15'], { windowsHide: true });
}

// ---------- сводка ----------

export async function runChecks(): Promise<SystemCheck[]> {
  const checks: SystemCheck[] = [];
  const admin = await isAdmin();
  checks.push({ id: 'admin', title: 'Права администратора', ok: admin, detail: admin ? 'есть — WinDivert может перехватывать пакеты' : 'нет — запустите приложение от имени администратора' });

  const ver = await winwsVersion();
  const files = ['winws2.exe', 'WinDivert.dll', 'WinDivert64.sys', 'cygwin1.dll'].filter((f) => !existsSync(join(res.bin(), f)));
  checks.push({ id: 'engine', title: 'Движок winws2 (zapret2)', ok: !!ver && files.length === 0, detail: files.length ? `нет файлов: ${files.join(', ')}` : ver ?? 'не запускается' });

  const foreign = (await listForeignEngines()).filter((p) => p.pid !== engine.state.pid);
  checks.push({
    id: 'conflicts', title: 'Другие обходчики (GoodbyeDPI, zapret, winws)',
    ok: foreign.length === 0 ? true : null,
    detail: foreign.length ? `запущены: ${foreign.map((f) => `${f.name} (${f.pid})`).join(', ')} — могут конфликтовать за WinDivert` : 'не обнаружены',
    fix: foreign.length ? 'kill-foreign' : undefined,
  });

  const ts = await tcpTimestamps();
  checks.push({ id: 'tcp-timestamps', title: 'Метки времени TCP (RFC 1323)', ok: ts, detail: ts ? 'включены' : 'выключены — часть стратегий с подделкой timestamp будет вешать соединения', fix: ts ? undefined : 'tcp-timestamps' });

  try {
    const proxy = await ps("(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings').ProxyEnable");
    const on = proxy.trim() === '1';
    checks.push({ id: 'sysproxy', title: 'Системный прокси', ok: on ? null : true, detail: on ? 'включён — трафик браузера может идти мимо обхода' : 'не используется' });
  } catch { /* необязательная проверка */ }

  try {
    const vpn = await ps("Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and ($_.InterfaceDescription -match 'TAP|WireGuard|Wintun|VPN|OpenVPN|Tunnel' ) } | Select-Object -ExpandProperty Name");
    checks.push({ id: 'vpn', title: 'VPN-адаптеры', ok: vpn ? null : true, detail: vpn ? `активны: ${vpn.split(/\r?\n/).join(', ')} — трафик через VPN обход не затрагивает` : 'не обнаружены' });
  } catch { /* необязательная проверка */ }

  const d = dohState();
  checks.push({
    id: 'doh', title: 'DNS через DoH',
    ok: d.active ? (d.dohErrors > d.queries / 2 && d.queries > 10 ? false : true) : null,
    detail: d.active
      ? `${d.url} · запросов ${d.queries}, из кэша ${d.cached}, ошибок DoH ${d.dohErrors}, через запасной DNS ${d.fallbacks}, заглушек РКН переспрошено ${d.stubbed}${d.lastError ? ` · последняя ошибка: ${d.lastError}` : ''}`
      : 'не используется (включается вместе с обходом, см. Настройки → DNS)',
  });
  const meta = await detectMetaBlocks();
  const blocked = meta.filter((m) => m.ip && !m.reachable);
  const fix = Object.entries(dnsFixState().map);
  const covered = blocked.filter((m) => fix.some(([b]) => b === m.ip));
  checks.push({
    id: 'meta-ip', title: 'Блокировка по IP (Meta и свои домены)',
    ok: blocked.length === 0 ? true : covered.length === blocked.length ? true : false,
    detail: blocked.length === 0
      ? 'адреса от DNS доступны'
      : `адрес от DNS заблокирован: ${blocked.map((m) => `${m.host} (${m.ip})`).join(', ')}` +
        (fix.length ? ` · движок подменяет в DNS-ответах: ${fix.map(([a, e]) => `${e.host || '?'} ${a}→${e.to}`).join(', ')}` : ' · подмена DNS не настроена'),
    fix: 'dnsfix-refresh',
  });
  return checks;
}

export async function killForeign() {
  for (const p of await listForeignEngines()) {
    if (p.pid === engine.state.pid) continue;
    await pexec('taskkill', ['/PID', String(p.pid), '/F'], { windowsHide: true }).catch(() => undefined);
    log.info('diag', `Завершён ${p.name} (${p.pid})`);
  }
}
