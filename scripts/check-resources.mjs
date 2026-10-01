// Проверка перед упаковкой: всё ли, что нужно приложению, лежит в resources/ (иначе соберётся нерабочий установщик)
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const need = [
  ['bin/winws2.exe', 'npm run fetch:engine'],
  ['bin/WinDivert.dll', 'npm run fetch:engine'],
  ['bin/WinDivert64.sys', 'npm run fetch:engine'],
  ['bin/cygwin1.dll', 'npm run fetch:engine'],
  ['lua/zapret-lib.lua', 'npm run fetch:engine'],
  ['strategies/z2k-profiles.txt', 'npm run fetch:engine'],
  ['lists/z2k/whitelist.txt', 'npm run fetch:engine'],
  ['lua-win/z2k-win-dnsfix.lua', 'файл из репозитория приложения'],
  ['cf-worker/worker.js', 'файл из репозитория приложения'],
  ['bin/z2k-warpd.exe', 'npm run build:warpd'],
  ['bin/wintun.dll', 'npm run build:warpd'],
];

const missing = need.filter(([f]) => !existsSync(join('resources', f)));
if (missing.length) {
  console.error('✘ Не хватает файлов в resources/ — установщик получился бы нерабочим:');
  for (const [f, how] of missing) console.error(`   ${f}  →  ${how}`);
  process.exit(1);
}
console.log(`✓ resources/: все ${need.length} обязательных файлов на месте`);
