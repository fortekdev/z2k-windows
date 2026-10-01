#!/usr/bin/env node
// Сборка релея Telegram z2k-vps-relay для своего VPS (linux/amd64, статический) → resources/vps-relay/.
//
//   node scripts/build-relay.mjs
//
// Исходники: vps-relay/ (копия из necronicle/z2k, MIT). Тулчейн тот же, что у WARP и z2k-tgredir:
// GO (путь к go.exe) или .tools/go — его скачивает `npm run build:warpd`.
// Рядом с бинарником лежит install.sh — его вместе с бинарником копируют на VPS.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const go = process.env.GO ?? join(ROOT, '.tools', 'go', 'bin', process.platform === 'win32' ? 'go.exe' : 'go');
if (!existsSync(go)) {
  console.error(`Не найден Go (${go}). Выполните npm run build:warpd — он скачает тулчейн в .tools/go — или задайте GO.`);
  process.exit(1);
}
const env = { ...process.env, GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0', GOTOOLCHAIN: 'local' };
const out = join(ROOT, 'resources', 'vps-relay', 'z2k-vps-relay');
execFileSync(go, ['build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -X main.buildVersion=z2k-windows', '-o', out, '.'], {
  cwd: join(ROOT, 'vps-relay'),
  env,
  stdio: 'inherit',
});
console.log(`✓ ${out}`);
