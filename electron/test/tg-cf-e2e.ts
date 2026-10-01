// Проверка режима Cloudflare Worker: node .tmp/tg-cf-e2e.cjs <ws-url> <secret>
import { TgProxy } from '../src/tg/proxy';
import { probeDc } from '../src/tg/selftest';
import { DEFAULT_SETTINGS } from '../src/settings';

(async () => {
  const [url, secret] = process.argv.slice(2);
  const proxy = new TgProxy();
  await proxy.start({ ...DEFAULT_SETTINGS.tg, port: 19081, mode: 'cfworker', cfWorkerUrl: url, cfWorkerSecret: secret, transparent: false });
  let failed = 0;
  // 7 параллельных потоков — больше лимита одной сессии, проверяем раскладку по нескольким WS
  const results = await Promise.all([1, 2, 3, 4, 5, -2, -4].map((dc) => probeDc(19081, dc)));
  for (const r of results) { if (!r.ok) failed++; console.log(`DC${r.dc}: ${r.ok ? 'OK ' : 'FAIL'} ${r.ms}ms ${r.detail}`); }
  // неверный секрет должен отвергаться
  const bad = new TgProxy();
  await bad.start({ ...DEFAULT_SETTINGS.tg, port: 19082, mode: 'cfworker', cfWorkerUrl: url, cfWorkerSecret: 'wrong', transparent: false });
  const r = await probeDc(19082, 2);
  console.log('wrong secret ->', r.ok ? 'ПРИНЯТ (ошибка!)' : `отвергнут (${r.detail})`);
  if (r.ok) failed++;
  await proxy.stop(); await bad.stop();
  process.exit(failed ? 1 : 0);
})();
