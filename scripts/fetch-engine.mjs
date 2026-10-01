// Скачивает и раскладывает в resources/ всё, что нужно движку:
//   - winws2.exe + WinDivert + cygwin1.dll из upstream bol-van/zapret2 (Windows-сборки форк z2k не выпускает);
//   - Lua-ядро zapret2 из форка necronicle/zapret2-z2k (его правки zapret-auto/antidpi — чистый Lua);
//   - z2k: Lua-детекторы, базы стратегий, списки, fake-блобы.
// Запуск: npm run fetch:engine [-- --force]
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RES = join(ROOT, 'resources');
const FORCE = process.argv.includes('--force');

const UPSTREAM_TAG = 'v1.0.5.2';
const FORK_TAG = 'v1.0.5.1-z2k-r3';
const Z2K_REF = 'z2k-enhanced';

const SOURCES = {
  upstream: `https://github.com/bol-van/zapret2/releases/download/${UPSTREAM_TAG}/zapret2-${UPSTREAM_TAG}.zip`,
  fork: `https://github.com/necronicle/zapret2-z2k/releases/download/${FORK_TAG}/zapret2-${FORK_TAG}.zip`,
  z2k: `https://codeload.github.com/necronicle/z2k/zip/refs/heads/${Z2K_REF}`,
};

const work = join(tmpdir(), 'z2k-win-fetch');

// Git Bash нужен только для прогона генератора z2k (POSIX sh)
function findBash() {
  const candidates = [
    join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const toPosix = (p) => p.split(sep).join('/');

mkdirSync(work, { recursive: true });

async function download(url, dest) {
  if (existsSync(dest) && !FORCE) return dest;
  console.log(`↓ ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

function unzip(zip, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // bsdtar из Windows 10+ умеет zip
  execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir], { stdio: 'inherit' });
  const [top] = readdirSync(dir);
  return join(dir, top);
}

function copyDir(src, dst, filter = () => true) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src, { withFileTypes: true })) {
    if (!filter(name.name)) continue;
    cpSync(join(src, name.name), join(dst, name.name), { recursive: true });
  }
}

const upstream = unzip(await download(SOURCES.upstream, join(work, 'upstream.zip')), join(work, 'upstream'));
const fork = unzip(await download(SOURCES.fork, join(work, 'fork.zip')), join(work, 'fork'));
const z2k = unzip(await download(SOURCES.z2k, join(work, 'z2k.zip')), join(work, 'z2k'));

// bin не чистим целиком: там же лежат z2k-warpd.exe и wintun.dll (scripts/build-warpd.mjs)
for (const d of ['lua', 'lists', 'fake']) rmSync(join(RES, d), { recursive: true, force: true });

copyDir(join(upstream, 'binaries', 'windows-x86_64'), join(RES, 'bin'), (n) =>
  ['winws2.exe', 'WinDivert.dll', 'WinDivert64.sys', 'cygwin1.dll'].includes(n));

copyDir(join(fork, 'lua'), join(RES, 'lua'), (n) => n.endsWith('.lua') && n !== 'zapret-tests.lua');
copyDir(join(z2k, 'files', 'lua'), join(RES, 'lua'));

copyDir(join(z2k, 'files', 'fake'), join(RES, 'fake'));
// upstream-блобы (fake_default_*, quic и т.п.), на которые ссылаются штатные стратегии
if (existsSync(join(fork, 'files', 'fake'))) copyDir(join(fork, 'files', 'fake'), join(RES, 'fake'), (n) => !existsSync(join(RES, 'fake', n)));

copyDir(join(z2k, 'files', 'lists'), join(RES, 'lists'));
mkdirSync(join(RES, 'strategies'), { recursive: true });
cpSync(join(z2k, 'strats_new2.txt'), join(RES, 'strategies', 'strats_new2.txt'));
cpSync(join(z2k, 'quic_strats.ini'), join(RES, 'strategies', 'quic_strats.ini'));
cpSync(join(z2k, 'extras', 'discord-voice-hosts.txt'), join(RES, 'lists', 'discord-voice-hosts.txt'));

// Профили winws2 — результат НАСТОЯЩЕГО генератора z2k (lib/config_official.sh), прогнанного в песочнице
const bash = findBash();
if (bash) {
  const out = join(work, 'genout');
  rmSync(out, { recursive: true, force: true });
  execFileSync(bash, [join(ROOT, 'scripts', 'gen-profiles.sh'), toPosix(z2k), toPosix(out)], { stdio: 'inherit' });
  cpSync(join(out, 'z2k-profiles.txt'), join(RES, 'strategies', 'z2k-profiles.txt'));
  cpSync(join(out, 'lists'), join(RES, 'lists', 'z2k'), { recursive: true });
} else {
  console.warn('! bash (Git for Windows) не найден — z2k-profiles.txt не пересобран');
}

writeFileSync(join(RES, 'engine-version.json'), JSON.stringify({
  winws2: UPSTREAM_TAG, luaCore: FORK_TAG, z2k: Z2K_REF, fetchedAt: new Date().toISOString(),
}, null, 2));
console.log('✓ resources/ обновлены');
