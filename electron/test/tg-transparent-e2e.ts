// Сквозная проверка прозрачного режима (нужны права администратора): node .tmp/tg-transparent-e2e.cjs
// Соединение ДРУГОГО процесса к IP Telegram должно перехватываться и доходить до прокси, после остановки — нет.
import { execFileSync } from 'node:child_process';
import { TgProxy } from '../src/tg/proxy';
import { DEFAULT_SETTINGS } from '../src/settings';
import { log } from '../src/logger';

// Подключение из отдельного процесса: соединения самого z2k (этого процесса) перехват не трогает
function connectFromChild(host: string, port: number): string {
  const js = `const s=require('net').connect(${port},'${host}');s.setTimeout(4000,()=>{console.log('timeout');process.exit()});s.on('connect',()=>{console.log('connected');s.end(Buffer.alloc(64,1));setTimeout(()=>process.exit(),500)});s.on('error',e=>{console.log('error '+e.code);process.exit()})`;
  return execFileSync(process.execPath, ['-e', js], { encoding: 'utf8' }).trim();
}

(async () => {
  log.on('entry', (e) => { if (e.source === 'tg') console.log(`  [tg] ${e.level} ${e.msg}`); });
  const proxy = new TgProxy();
  await proxy.start({ ...DEFAULT_SETTINGS.tg, port: 19083, mode: 'direct', transparent: true });
  const st = proxy.state().transparent;
  console.log('перехват:', st);
  const on = connectFromChild('149.154.167.51', 443);
  console.log('с перехватом:', on);
  await new Promise((r) => setTimeout(r, 1500));
  const dcs = proxy.state().dcs.map((d) => d.dc);
  console.log('прокси видел:', dcs);
  await proxy.stop();
  console.log('после остановки:', proxy.state().transparent);
  const ok = st.running && on === 'connected' && dcs.length > 0 && !proxy.state().transparent.running;
  console.log(ok ? 'ALL PASS' : 'FAILED');
  process.exit(ok ? 0 : 1);
})();
