// Тесты: main-процесс (бандлим electron/test/*.test.ts, electron → заглушка, node --test)
// и Lua приложения (electron/test/*.test.lua на LuaJIT самого winws2, режим --intercept=0)
import { build } from 'esbuild';
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const tests = readdirSync('electron/test').filter((f) => f.endsWith('.test.ts'));
const outs = [];
for (const t of tests) {
  const outfile = `.tmp/tests/${t.replace(/\.ts$/, '.cjs')}`;
  await build({ entryPoints: [`electron/test/${t}`], bundle: true, platform: 'node', format: 'cjs', outfile, alias: { electron: './electron/test/electron-stub.ts' }, logLevel: 'warning' });
  outs.push(outfile);
}
let status = spawnSync(process.execPath, ['--test', ...outs], { stdio: 'inherit' }).status ?? 1;

const winws = resolve('resources/bin/winws2.exe');
const p = (f) => resolve(f).split('\\').join('/');
if (existsSync(winws)) {
  for (const t of readdirSync('electron/test').filter((f) => f.endsWith('.test.lua'))) {
    const r = spawnSync(winws, ['--intercept=0', `--lua-init=@${p('resources/lua/zapret-lib.lua')}`, `--lua-init=@${p('resources/lua-win/z2k-win-dnsfix.lua')}`, `--lua-init=@${p(`electron/test/${t}`)}`], { encoding: 'utf8', cwd: resolve('resources/bin') });
    const out = `${r.stdout}${r.stderr}`.split(/\r?\n/).filter((l) => /^(PASS|FAIL|ALL PASS|FAILED)|LUA ERROR/.test(l));
    console.log(`\n# lua ${t}\n${out.join('\n')}`);
    if (!out.some((l) => l === 'ALL PASS')) status = 1;
  }
} else {
  console.log('# lua: winws2.exe не найден — Lua-тесты пропущены');
}
process.exit(status);
