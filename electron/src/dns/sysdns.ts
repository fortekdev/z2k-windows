// DNS сетевых адаптеров на время работы обхода → 127.0.0.1 / ::1 (локальный DoH-прокси) и обратно.
// Прежние настройки (DHCP или статические, отдельно IPv4 и IPv6) сохраняются в файл ДО изменения —
// если приложение упадёт, при следующем запуске они будут восстановлены.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { data } from '../paths';
import { log } from '../logger';

const pexec = promisify(execFile);
const restoreFile = () => join(data.run(), 'dns-restore.json');

interface SavedIf {
  ifIndex: number;
  alias: string;
  guid: string;
  v4Static: string[]; // пусто — DNS от DHCP
  v6Static: string[];
  effective: string[]; // что было в работе (для запасного DNS прокси)
}

async function ps<T>(script: string): Promise<T> {
  const { stdout } = await pexec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 30_000, maxBuffer: 4 << 20 });
  const t = stdout.trim();
  return (t ? JSON.parse(t) : []) as T;
}

/** Адаптеры с основным шлюзом (через них идёт интернет); туннели WARP не трогаем */
async function activeInterfaces(): Promise<SavedIf[]> {
  const list = await ps<SavedIf[] | SavedIf>(`
    $r = @()
    Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' -and $_.InterfaceAlias -notlike 'z2k-warp*' } | ForEach-Object {
      $g = $_.NetAdapter.InterfaceGuid
      $v4 = (Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$g" -ErrorAction SilentlyContinue).NameServer
      $v6 = (Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters\\Interfaces\\$g" -ErrorAction SilentlyContinue).NameServer
      $eff = @(Get-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex | ForEach-Object { $_.ServerAddresses })
      $r += [pscustomobject]@{ ifIndex = $_.InterfaceIndex; alias = $_.InterfaceAlias; guid = "$g";
        v4Static = @(if ($v4) { $v4 -split '[ ,]+' | Where-Object { $_ } } else { @() });
        v6Static = @(if ($v6) { $v6 -split '[ ,]+' | Where-Object { $_ } } else { @() });
        effective = $eff }
    }
    ConvertTo-Json -InputObject @($r) -Depth 4 -Compress`);
  return Array.isArray(list) ? list : [list];
}

let applied: SavedIf[] | null = null;

/** Текущие рабочие DNS-серверы активных адаптеров (до переключения — для запасного пути прокси) */
export async function currentDnsServers(): Promise<string[]> {
  const ifs = await activeInterfaces();
  return [...new Set(ifs.flatMap((i) => i.effective))].filter((a) => a !== '127.0.0.1' && a !== '::1' && !a.startsWith('fec0:'));
}

/** Переключить DNS адаптеров на локальный прокси. Возвращает прежние рабочие DNS-серверы (для запасного пути). */
export async function pointDnsToLocal(): Promise<string[]> {
  if (existsSync(restoreFile())) await restoreDns(); // хвост прошлого запуска
  const ifs = await activeInterfaces();
  if (!ifs.length) throw new Error('не найдено активных сетевых адаптеров с основным шлюзом');
  writeFileSync(restoreFile(), JSON.stringify(ifs, null, 2));
  for (const i of ifs) {
    await ps(`Set-DnsClientServerAddress -InterfaceIndex ${i.ifIndex} -ServerAddresses ('127.0.0.1','::1')`);
  }
  await ps('Clear-DnsClientCache');
  applied = ifs;
  log.info('diag', `DNS адаптеров переключён на DoH-прокси: ${ifs.map((i) => i.alias).join(', ')}`);
  return [...new Set(ifs.flatMap((i) => i.effective))].filter((a) => a !== '127.0.0.1' && a !== '::1' && !a.startsWith('fec0:'));
}

/** Вернуть DNS адаптеров как было (из памяти или из файла после сбоя) */
export async function restoreDns(): Promise<void> {
  let ifs = applied;
  if (!ifs && existsSync(restoreFile())) {
    try { ifs = JSON.parse(readFileSync(restoreFile(), 'utf8')) as SavedIf[]; } catch { ifs = null; }
  }
  if (!ifs) return;
  for (const i of ifs) {
    const cmds = [`Set-DnsClientServerAddress -InterfaceIndex ${i.ifIndex} -ResetServerAddresses -ErrorAction SilentlyContinue`];
    const statics = [...i.v4Static, ...i.v6Static].map((a) => `'${a.replace(/'/g, '')}'`);
    if (statics.length) cmds.push(`Set-DnsClientServerAddress -InterfaceIndex ${i.ifIndex} -ServerAddresses (${statics.join(',')}) -ErrorAction SilentlyContinue`);
    await ps(cmds.join('; ')).catch((e: Error) => log.warn('diag', `DNS ${i.alias}: ${e.message}`));
  }
  await ps('Clear-DnsClientCache').catch(() => undefined);
  rmSync(restoreFile(), { force: true });
  applied = null;
  log.info('diag', `DNS адаптеров восстановлен: ${ifs.map((i) => `${i.alias} (${[...i.v4Static, ...i.v6Static].join(', ') || 'DHCP'})`).join('; ')}`);
}

export function dnsSwitched(): boolean {
  return applied !== null || existsSync(restoreFile());
}

/** Синхронное восстановление при выходе (нельзя ждать async в обработчике завершения) */
export function restoreDnsSync() {
  if (!dnsSwitched()) return;
  try {
    const ifs = applied ?? (JSON.parse(readFileSync(restoreFile(), 'utf8')) as SavedIf[]);
    const script = ifs.map((i) => {
      const statics = [...i.v4Static, ...i.v6Static].map((a) => `'${a.replace(/'/g, '')}'`);
      return `Set-DnsClientServerAddress -InterfaceIndex ${i.ifIndex} -ResetServerAddresses -ErrorAction SilentlyContinue` +
        (statics.length ? `; Set-DnsClientServerAddress -InterfaceIndex ${i.ifIndex} -ServerAddresses (${statics.join(',')}) -ErrorAction SilentlyContinue` : '');
    }).join('; ') + '; Clear-DnsClientCache';
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 });
    rmSync(restoreFile(), { force: true });
    applied = null;
  } catch { /* файл восстановления останется — вернём при следующем запуске */ }
}
