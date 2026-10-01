// Выпуск релиза: тег vX.Y.Z → GitHub Actions собирает portable-exe и публикует его в Releases.
//   npm run release            — релиз текущей версии из package.json
//   npm run release -- patch   — поднять версию (0.1.0 → 0.1.1), закоммитить и выпустить; также minor / major
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const fail = (msg) => { console.error(`✘ ${msg}`); process.exit(1); };

const bump = process.argv[2];
if (bump && !['patch', 'minor', 'major'].includes(bump)) fail(`неизвестный аргумент «${bump}»: patch, minor или major`);

if (git('status', '--porcelain')) fail('есть незакоммиченные изменения — сначала закоммитьте их (git add, git commit)');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') fail(`релизы выпускаются из ветки main, а сейчас ${branch}`);

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
let version = pkg.version;
if (bump) {
  const [ma, mi, pa] = version.split('.').map(Number);
  version = bump === 'major' ? `${ma + 1}.0.0` : bump === 'minor' ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
  pkg.version = version;
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
  git('add', 'package.json', 'package-lock.json');
  git('commit', '-m', `Версия ${version}`);
  console.log(`✓ версия поднята: ${pkg.version}`);
}

const tag = `v${version}`;
git('fetch', '--tags', 'origin');
if (git('tag', '--list', tag)) fail(`тег ${tag} уже есть — поднимите версию: npm run release -- patch`);

git('tag', '-a', tag, '-m', `z2k Windows ${tag}`);
console.log(`✓ тег ${tag} создан, отправляю на GitHub…`);
execFileSync('git', ['push', 'origin', 'main', tag], { stdio: 'inherit' });

const remote = git('remote', 'get-url', 'origin').replace(/^https:\/\/[^@]+@/, 'https://').replace(/\.git$/, '');
console.log(`\n✓ Сборка запущена: ${remote}/actions`);
console.log(`  Через ~5–10 минут exe появится здесь: ${remote}/releases/tag/${tag}`);
