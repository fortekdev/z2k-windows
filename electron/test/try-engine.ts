import { DEFAULT_SETTINGS } from '../src/settings';
import { engine } from '../src/engine/winws';
import { ensureUserLists } from '../src/engine/lists';
import { log } from '../src/logger';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { data } from '../src/paths';
import { join } from 'node:path';

log.on('entry', (e) => { if (e.level !== 'debug') console.log(`[${e.source}] ${e.msg}`); });
ensureUserLists();
(async () => {
  const st = await engine.start({ ...DEFAULT_SETTINGS, debugEngine: true });
  console.log('STATE', st.status, st.pid, st.lastError);
  for (const u of ['https://rutracker.org', 'https://www.youtube.com', 'https://discord.com', 'https://www.instagram.com', 'https://example.com']) {
    try { console.log(u, execSync(`curl -s -o NUL -m 12 -w "%{http_code} %{size_download}B %{time_total}s" ${u}`).toString()); } catch (e) { console.log(u, 'FAIL'); }
  }
  for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 2500)); try { execSync('curl -s -o NUL -m 8 https://rutracker.org'); } catch {} }
  const f = join(data.state(), 'state.tsv');
  console.log('state.tsv exists', existsSync(f));
  if (existsSync(f)) console.log(readFileSync(f, 'utf8'));
  await engine.stop();
  process.exit(0);
})();
