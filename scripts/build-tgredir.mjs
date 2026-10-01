#!/usr/bin/env node
// Сборка z2k-tgredir (прозрачный перехват Telegram через WinDivert) → resources/bin/.
//
//   node scripts/build-tgredir.mjs
//
// Исходники: tgredir/ (только стандартная библиотека Go). Тулчейн тот же, что у WARP:
// GO (путь к go.exe) или .tools/go — его скачивает `npm run build:warpd`.
// WinDivert.dll/WinDivert64.sys берутся общие с winws2 (scripts/fetch-engine.mjs).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const go = process.env.GO ?? join(ROOT, '.tools', 'go', 'bin', process.platform === 'win32' ? 'go.exe' : 'go');
if (!existsSync(go)) {
  console.error(`Не найден Go (${go}). Выполните npm run build:warpd — он скачает тулчейн в .tools/go — или задайте GO.`);
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const env = { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0', GOTOOLCHAIN: 'local' };
const exe = join(ROOT, 'resources', 'bin', 'z2k-tgredir.exe');
execFileSync(go, ['vet', '.'], { cwd: join(ROOT, 'tgredir'), env, stdio: 'inherit' });
execFileSync(go, ['build', '-trimpath', '-buildvcs=false', `-ldflags=-s -w -X main.version=z2k-windows-${pkg.version}`, '-o', exe, '.'], {
  cwd: join(ROOT, 'tgredir'),
  env,
  stdio: 'inherit',
});
console.log(`✓ ${exe}`);
