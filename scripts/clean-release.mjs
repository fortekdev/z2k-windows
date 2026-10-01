// После сборки в release/ оставляем только портативный exe текущей версии:
// win-unpacked, builder-*.yml и старые сборки — промежуточные файлы electron-builder
import { readdirSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const keep = `z2k-windows-${version}-portable.exe`;
const dir = 'release';

let found = false;
for (const name of readdirSync(dir)) {
  if (name === keep) { found = true; continue; }
  rmSync(join(dir, name), { recursive: true, force: true });
}
if (!found) {
  console.error(`✘ ${dir}/${keep} не найден — сборка не удалась`);
  process.exit(1);
}
console.log(`✓ ${dir}\\${keep} (${(statSync(join(dir, keep)).size / 1024 / 1024).toFixed(0)} МБ) — один файл, запускается без установки`);
