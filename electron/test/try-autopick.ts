import { DEFAULT_SETTINGS } from '../src/settings';
import { autopick } from '../src/autopick/autopick';
import { log } from '../src/logger';

log.on('entry', (e) => { if (e.level !== 'debug') console.log(`[${e.source}] ${e.msg}`); });
(async () => {
  const job = await autopick.run({ pool: (process.argv[2] ?? 'rkn_tcp') as never, host: process.argv[3] ?? 'rutracker.org', apply: false, freeze: false, stopOnFirst: true, repeats: 2 }, DEFAULT_SETTINGS);
  console.log('JOB', job.status, 'tested', job.tested, '/', job.total, 'found', job.found, job.error ?? '');
  process.exit(0);
})();
