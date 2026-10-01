// Обёртка над `next dev renderer -p 3123` для задачи VS Code "dev: renderer (Next.js)" и `npm run dev`.
//   • порт свободен                         → запускает next dev как обычно;
//   • на порту живой next dev ЭТОГО проекта → не запускает второй, печатает строку "Ready" и ждёт
//     (problemMatcher в .vscode/tasks.json срабатывает, F5 продолжается);
//   • на порту зависший next dev этого проекта → убивает его и запускает свежий;
//   • порт занят чужим процессом            → понятная ошибка, ничего не трогает.
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import net from 'node:net';

const PORT = 3123;
const URL_ = `http://localhost:${PORT}/`;
const ROOT = resolve(import.meta.dirname, '..');
const isWin = process.platform === 'win32';
// Нормализуем путь: регистр, слэши, "node_modules\.bin\..\next" → "node_modules\next"
const norm = (s) => (s || '').toLowerCase().replace(/[\\/]+/g, '\\').replaceAll('\\.bin\\..\\', '\\');

function portBusy() {
  return new Promise((res) => {
    const s = net.connect({ port: PORT, host: 'localhost' });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
    s.setTimeout(1500, () => { s.destroy(); res(false); });
  });
}

async function healthy() {
  try {
    const r = await fetch(URL_, { signal: AbortSignal.timeout(15000), redirect: 'manual' });
    return /next\.js/i.test(r.headers.get('x-powered-by') || '');
  } catch {
    return false;
  }
}

// Windows: PID слушателя порта и его командная строка (+ родитель)
function listener() {
  if (!isWin) return null;
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
    const line = out.split(/\r?\n/).find((l) => /LISTENING/i.test(l) && new RegExp(`:${PORT}\\s`).test(l));
    const pid = line && Number(line.trim().split(/\s+/).pop());
    if (!pid) return null;
    const ps = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; $q=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.ParentProcessId); @{pid=$p.ProcessId;cmd=$p.CommandLine;ppid=$q.ProcessId;pcmd=$q.CommandLine} | ConvertTo-Json -Compress`;
    return JSON.parse(execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }));
  } catch {
    return null;
  }
}

const ours = (cmd) => norm(cmd).includes(norm(ROOT) + '\\node_modules\\next\\');

function killTree(pid) {
  try {
    if (isWin) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch { /* уже завершён */ }
}

function startNext() {
  const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next', { paths: [ROOT] });
  const child = spawn(process.execPath, [nextBin, 'dev', 'renderer', '-p', String(PORT)], { cwd: ROOT, stdio: 'inherit' });
  const stop = () => { killTree(child.pid); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  child.on('exit', (code) => process.exit(code ?? 0));
}

if (!(await portBusy())) {
  startNext();
} else {
  const l = listener();
  if (l && !ours(l.cmd)) {
    console.error(`✘ Порт ${PORT} занят чужим процессом (PID ${l.pid}): ${l.cmd}`);
    console.error('  Освободите порт и перезапустите задачу.');
    process.exit(1);
  }
  if (await healthy()) {
    // Те же строки, что печатает next dev, — их ловит problemMatcher задачи
    const { version } = createRequire(import.meta.url)('next/package.json');
    console.log(`▲ Next.js ${version} — dev-сервер уже запущен на ${URL_} (PID ${l?.pid ?? '?'}), используем его`);
    console.log('✓ Ready in 0ms (reused)');
    // Держим задачу активной, пока жив сервер; если он пропадёт — поднимаем свой
    const timer = setInterval(async () => {
      if (await portBusy()) return;
      clearInterval(timer);
      console.log('Внешний dev-сервер остановлен — запускаю свой');
      startNext();
    }, 5000);
  } else {
    if (!l) {
      console.error(`✘ Порт ${PORT} занят, но не отвечает как Next.js, и владельца определить не удалось.`);
      process.exit(1);
    }
    const target = /next[\\/]dist[\\/]bin[\\/]next/i.test(l.pcmd || '') && ours(l.pcmd) ? l.ppid : l.pid;
    console.log(`Порт ${PORT} держит зависший next dev (PID ${target}) — завершаю его`);
    killTree(target);
    for (let i = 0; i < 20 && (await portBusy()); i++) await new Promise((r) => setTimeout(r, 500));
    startNext();
  }
}
