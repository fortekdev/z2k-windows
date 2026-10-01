#!/usr/bin/env node
// Сборка WARP-движка z2k-warpd под Windows (amd64) → resources/bin/.
//
//   node scripts/build-warpd.mjs
//
// Исходники: warp/z2k-warpd (порт upstream z2k, MIT; vendored wireguard-go
// в third_party). Тулчейн: .tools/go (портативный Go, не трогает PATH);
// нет — скачивается с go.dev с проверкой sha256. wintun.dll (amd64) берётся
// из официального wintun-0.14.1.zip (www.wintun.net), sha256 пинован.
//
// Результат: resources/bin/z2k-warpd.exe, resources/bin/wintun.dll,
// resources/bin/wintun-LICENSE.txt.
//
// Переменные: Z2K_GO_VERSION (по умолчанию go1.25.14), GO (путь к go.exe —
// использовать готовый тулчейн).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, '.tools');
const SRC = join(ROOT, 'warp', 'z2k-warpd');
const OUT = join(ROOT, 'resources', 'bin');

const GO_VERSION = process.env.Z2K_GO_VERSION ?? 'go1.25.14';
const WINTUN = {
  url: 'https://www.wintun.net/builds/wintun-0.14.1.zip',
  sha256: '07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51',
};

const isWin = process.platform === 'win32';

async function download(url, dest, sha256) {
  console.log(`↓ ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(buf).digest('hex');
  if (sha256 && got !== sha256) throw new Error(`${url}: sha256 ${got} != ${sha256}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  return dest;
}

function unzip(zip, dir) {
  mkdirSync(dir, { recursive: true });
  if (isWin) {
    // bsdtar из Windows 10+ умеет zip
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-q', '-o', zip, '-d', dir], { stdio: 'inherit' });
  }
}

async function ensureGo() {
  if (process.env.GO) return process.env.GO;
  const goExe = join(TOOLS, 'go', 'bin', isWin ? 'go.exe' : 'go');
  if (existsSync(goExe)) return goExe;
  // Хост-тулчейн нужной платформы; кросс-компиляция под windows/amd64 —
  // через GOOS/GOARCH ниже.
  const os = isWin ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const list = await (await fetch('https://go.dev/dl/?mode=json&include=all')).json();
  const rel = list.find((r) => r.version === GO_VERSION);
  if (!rel) throw new Error(`Go ${GO_VERSION} не найден на go.dev`);
  const file = rel.files.find((f) => f.os === os && f.arch === arch && f.kind === 'archive');
  if (!file) throw new Error(`нет архива Go ${GO_VERSION} для ${os}/${arch}`);
  const archive = await download(`https://go.dev/dl/${file.filename}`, join(TOOLS, file.filename), file.sha256);
  rmSync(join(TOOLS, 'go'), { recursive: true, force: true });
  if (file.filename.endsWith('.zip')) unzip(archive, TOOLS);
  else execFileSync('tar', ['-xzf', archive, '-C', TOOLS], { stdio: 'inherit' });
  rmSync(archive, { force: true });
  return goExe;
}

async function ensureWintun() {
  const dll = join(TOOLS, 'wintun', 'bin', 'amd64', 'wintun.dll');
  if (existsSync(dll)) return join(TOOLS, 'wintun');
  const zip = await download(WINTUN.url, join(TOOLS, 'wintun.zip'), WINTUN.sha256);
  unzip(zip, TOOLS);
  rmSync(zip, { force: true });
  return join(TOOLS, 'wintun');
}

const go = await ensureGo();
const wintun = await ensureWintun();
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const env = {
  ...process.env,
  GOOS: 'windows',
  GOARCH: 'amd64',
  CGO_ENABLED: '0',
  GOTOOLCHAIN: 'local',
};
console.log(execFileSync(go, ['version'], { env }).toString().trim());

mkdirSync(OUT, { recursive: true });
const exe = join(OUT, 'z2k-warpd.exe');
execFileSync(
  go,
  [
    'build',
    '-trimpath',
    '-buildvcs=false',
    `-ldflags=-s -w -X main.version=z2k-windows-${pkg.version}`,
    '-o',
    exe,
    './cmd/z2k-warpd',
  ],
  { cwd: SRC, env, stdio: 'inherit' },
);
copyFileSync(join(wintun, 'bin', 'amd64', 'wintun.dll'), join(OUT, 'wintun.dll'));
copyFileSync(join(wintun, 'LICENSE.txt'), join(OUT, 'wintun-LICENSE.txt'));
console.log(`✓ ${exe}\n✓ ${join(OUT, 'wintun.dll')}`);
