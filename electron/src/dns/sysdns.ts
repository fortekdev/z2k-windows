// DNS сетевых адаптеров на время работы обхода → 127.0.0.1 / ::1 (локальный DoH-прокси) и обратно.
//
// Настройка DNS адаптера в Windows постоянная (переживает перезагрузку), а прокси живёт только вместе с
// программой. Если DNS не вернуть, у человека «нет доступа к интернету», пока программа не запущена.
// Поэтому прежние настройки сохраняются в файл ДО изменения, а возвращает их любой из трёх путей:
//   1) штатный выход / остановка обхода / завершение сеанса Windows (выключение, перезагрузка, выход) — main.ts;
//   2) сторожевой процесс: ждёт завершения программы (сбой, «Снять задачу», остановка отладки) и возвращает DNS;
//   3) задача планировщика при загрузке Windows: если файл восстановления остался — вернуть DNS ещё до входа.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { data } from '../paths';
import { log } from '../logger';

const pexec = promisify(execFile);
const restoreFile = () => join(data.run(), 'dns-restore.json');
const restoreScript = () => join(data.run(), 'dns-restore.ps1');
const BOOT_TASK = 'z2k-windows-dns-restore';

interface SavedIf {
  ifIndex: number;
  alias: string;
  guid: string;
  v4Static: string[]; // пусто — DNS от DHCP
  v6Static: string[];
  effective: string[]; // что было в работе (для запасного DNS прокси)
}
interface RestoreFile { ownerPid: number; ifs: SavedIf[] }

async function ps<T>(script: string): Promise<T> {
  const { stdout } = await pexec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 30_000, maxBuffer: 4 << 20 });
  const t = stdout.trim();
  return (t ? JSON.parse(t) : []) as T;
}

/**
 * Адаптеры с основным шлюзом (через них идёт интернет); туннели WARP не трогаем.
 * Статическим DNS считаем только то, что задано вручную: если «статический» адрес совпадает с выданным
 * по DHCP или это наш же 127.0.0.1 — это DHCP. Иначе при восстановлении адрес роутера записался бы
 * навсегда, и в другой сети Wi-Fi интернета бы не было.
 */
async function activeInterfaces(): Promise<SavedIf[]> {
  const list = await ps<SavedIf[] | SavedIf>(`
    $r = @()
    $loop = @('127.0.0.1', '::1')
    Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' -and $_.InterfaceAlias -notlike 'z2k-warp*' } | ForEach-Object {
      $g = $_.NetAdapter.InterfaceGuid
      $p4 = Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$g" -ErrorAction SilentlyContinue
      $p6 = Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters\\Interfaces\\$g" -ErrorAction SilentlyContinue
      $split = { param($s) if ($s) { @($s -split '[ ,]+' | Where-Object { $_ }) } else { @() } }
      $s4 = & $split $p4.NameServer; $d4 = & $split $p4.DhcpNameServer
      $s6 = & $split $p6.NameServer; $d6 = & $split $p6.DhcpNameServer
      if (($s4 | Where-Object { $loop -contains $_ }) -or ($s4.Count -and -not (Compare-Object $s4 $d4))) { $s4 = @() }
      if (($s6 | Where-Object { $loop -contains $_ }) -or ($s6.Count -and -not (Compare-Object $s6 $d6))) { $s6 = @() }
      $eff = @(Get-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex | ForEach-Object { $_.ServerAddresses })
      $r += [pscustomobject]@{ ifIndex = $_.InterfaceIndex; alias = $_.InterfaceAlias; guid = "$g"; v4Static = @($s4); v6Static = @($s6); effective = $eff }
    }
    ConvertTo-Json -InputObject @($r) -Depth 4 -Compress`);
  return Array.isArray(list) ? list : [list];
}

function readRestore(): RestoreFile | null {
  if (!existsSync(restoreFile())) return null;
  try {
    const j = JSON.parse(readFileSync(restoreFile(), 'utf8')) as RestoreFile | SavedIf[];
    return Array.isArray(j) ? { ownerPid: 0, ifs: j } : j; // старый формат — просто массив
  } catch {
    return null;
  }
}

let applied: SavedIf[] | null = null;

// ---------- страховки: сторожевой процесс и задача при загрузке ----------

/**
 * Скрипт восстановления (его зовут и сторож, и задача при загрузке).
 * Адаптер ищется по GUID — номер интерфейса после перезагрузки может смениться.
 * -OwnerPid N: дождаться завершения программы и вернуть DNS, только если файл всё ещё её
 * (новый запуск программы перепишет файл своим PID — тогда старый сторож ничего не трогает).
 */
const RESTORE_PS1 = `param([int]$OwnerPid = 0)
$f = '${'@@FILE@@'}'
if ($OwnerPid -gt 0) { try { Wait-Process -Id $OwnerPid -ErrorAction SilentlyContinue } catch {}; Start-Sleep -Seconds 2 }
if (-not (Test-Path $f)) { exit 0 }
try { $j = Get-Content $f -Raw | ConvertFrom-Json } catch { exit 0 }
$ifs = if ($j -is [array]) { $j } else { $j.ifs }
if ($OwnerPid -gt 0 -and -not ($j -is [array]) -and $j.ownerPid -ne $OwnerPid) { exit 0 }
foreach ($i in $ifs) {
  $a = Get-NetAdapter | Where-Object { $_.InterfaceGuid -eq $i.guid } | Select-Object -First 1
  $idx = if ($a) { $a.ifIndex } else { $i.ifIndex }
  Set-DnsClientServerAddress -InterfaceIndex $idx -ResetServerAddresses -ErrorAction SilentlyContinue
  $st = @($i.v4Static) + @($i.v6Static) | Where-Object { $_ }
  if ($st.Count) { Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses $st -ErrorAction SilentlyContinue }
}
Clear-DnsClientCache
Remove-Item $f -Force -ErrorAction SilentlyContinue
`;

function writeRestoreScript() {
  writeFileSync(restoreScript(), '﻿' + RESTORE_PS1.replace('@@FILE@@', restoreFile().replace(/'/g, "''")));
}

/**
 * Сторож: отдельный скрытый процесс ждёт завершения программы и возвращает DNS, если она не успела сама.
 * Запускается через WMI (Win32_Process.Create), а не как дочерний: так он не входит в дерево процессов
 * программы и переживает «Снять задачу» / остановку отладки (они завершают всё дерево). К тому же
 * отсоединённый PowerShell без консоли, запущенный напрямую из Node, не стартует вовсе.
 */
async function startWatchdog() {
  const cmd = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${restoreScript()}" -OwnerPid ${process.pid}`;
  const script = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmd.replace(/'/g, "''")}' }; "$($r.ReturnValue)"`;
  try {
    const { stdout } = await pexec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 });
    if (stdout.trim() !== '0') log.warn('diag', `DNS: сторожевой процесс не запущен (код ${stdout.trim()})`);
  } catch (e) {
    log.warn('diag', `DNS: сторожевой процесс не запущен (${(e as Error).message})`);
  }
}

/** Задача при загрузке Windows (от SYSTEM): вернуть DNS, если программа не успела при выключении */
async function ensureBootTask() {
  try {
    await pexec('schtasks', ['/Query', '/TN', BOOT_TASK], { windowsHide: true });
    return;
  } catch { /* задачи ещё нет */ }
  const tr = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${restoreScript()}"`;
  await pexec('schtasks', ['/Create', '/TN', BOOT_TASK, '/SC', 'ONSTART', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/TR', tr, '/F'], { windowsHide: true })
    .catch((e: Error) => log.warn('diag', `DNS: задача восстановления при загрузке не создана (${e.message})`));
}

/** Убрать задачу при загрузке (когда DoH выключают совсем) */
export async function removeBootTask() {
  await pexec('schtasks', ['/Delete', '/TN', BOOT_TASK, '/F'], { windowsHide: true }).catch(() => undefined);
}

// ---------- переключение и восстановление ----------

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
  // Сначала страховки и файл восстановления, потом изменение
  writeRestoreScript();
  writeFileSync(restoreFile(), JSON.stringify({ ownerPid: process.pid, ifs } satisfies RestoreFile, null, 2));
  await ensureBootTask();
  await startWatchdog();
  for (const i of ifs) {
    await ps(`Set-DnsClientServerAddress -InterfaceIndex ${i.ifIndex} -ServerAddresses ('127.0.0.1','::1')`);
  }
  await ps('Clear-DnsClientCache');
  applied = ifs;
  log.info('diag', `DNS адаптеров переключён на DoH-прокси: ${ifs.map((i) => i.alias).join(', ')}`);
  return [...new Set(ifs.flatMap((i) => i.effective))].filter((a) => a !== '127.0.0.1' && a !== '::1' && !a.startsWith('fec0:'));
}

function restoreCommands(i: SavedIf): string {
  const statics = [...i.v4Static, ...i.v6Static].map((a) => `'${a.replace(/'/g, '')}'`);
  return `Set-DnsClientServerAddress -InterfaceIndex ${i.ifIndex} -ResetServerAddresses -ErrorAction SilentlyContinue` +
    (statics.length ? `; Set-DnsClientServerAddress -InterfaceIndex ${i.ifIndex} -ServerAddresses (${statics.join(',')}) -ErrorAction SilentlyContinue` : '');
}

/** Вернуть DNS адаптеров как было (из памяти или из файла после сбоя) */
export async function restoreDns(): Promise<void> {
  const ifs = applied ?? readRestore()?.ifs ?? null;
  if (!ifs) return;
  for (const i of ifs) {
    await ps(restoreCommands(i)).catch((e: Error) => log.warn('diag', `DNS ${i.alias}: ${e.message}`));
  }
  await ps('Clear-DnsClientCache').catch(() => undefined);
  rmSync(restoreFile(), { force: true }); // сторож увидит, что файла нет, и ничего не тронет
  applied = null;
  log.info('diag', `DNS адаптеров восстановлен: ${ifs.map((i) => `${i.alias} (${[...i.v4Static, ...i.v6Static].join(', ') || 'DHCP'})`).join('; ')}`);
}

export function dnsSwitched(): boolean {
  return applied !== null || existsSync(restoreFile());
}

/** Синхронное восстановление при выходе и завершении сеанса Windows (async там не дождаться) */
export function restoreDnsSync() {
  if (!dnsSwitched()) return;
  try {
    const ifs = applied ?? readRestore()?.ifs ?? [];
    const script = ifs.map(restoreCommands).join('; ') + '; Clear-DnsClientCache';
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 });
    rmSync(restoreFile(), { force: true });
    applied = null;
  } catch { /* файл останется — DNS вернёт сторож или задача при загрузке */ }
}
