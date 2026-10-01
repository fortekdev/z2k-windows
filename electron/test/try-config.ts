import { DEFAULT_SETTINGS } from '../src/settings';
import { buildEngineConfig } from '../src/engine/config';
import { ensureUserLists } from '../src/engine/lists';
import { dryRun } from '../src/engine/winws';

ensureUserLists();
const cfg = buildEngineConfig(DEFAULT_SETTINGS);
console.log('pools', cfg.pools, 'tcp', cfg.tcpPorts, 'udp', cfg.udpPorts, 'args', cfg.args.length);
console.log(cfg.args.filter((a) => !a.startsWith('--lua-desync=') || a.includes('circular')).join('\n').slice(0, 6000));
dryRun(cfg.args).then((r) => console.log('DRYRUN', r.ok, r.output.slice(-800)));
