// Сквозная проверка Telegram-прокси на настоящих DC: node .tmp/tg-e2e.cjs [ws|direct]
import { TgProxy } from '../src/tg/proxy';
import { probeDc } from '../src/tg/selftest';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { TgMode } from '../../shared/types';

(async () => {
  const mode = (process.argv[2] ?? 'ws') as TgMode;
  const proxy = new TgProxy();
  await proxy.start({ ...DEFAULT_SETTINGS.tg, port: 19080, mode, wsFallbackDirect: false, transparent: false });
  let failed = 0;
  for (const dc of [1, 2, 3, 4, 5, -2, -4]) {
    const r = await probeDc(19080, dc);
    if (!r.ok) failed++;
    console.log(`DC${dc}: ${r.ok ? 'OK ' : 'FAIL'} ${r.ms}ms ${r.detail}`);
  }
  await proxy.stop();
  process.exit(failed ? 1 : 0);
})();
