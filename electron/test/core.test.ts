import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadProfiles, parseCustomStrategy, singleStrategyProfile, strategyLines, strategyNumbers, applyCustom } from '../src/engine/profiles';
import { makeClientInit, PacketSplitter, parseInit, TAG_ABRIDGED, TAG_INTERMEDIATE } from '../src/tg/obfs';
import { isTelegramIp } from '../src/tg/proxy';
import { domainCovers, filterGoogle, normalizeDomain } from '../src/engine/lists';
import { quoteArg } from '../src/engine/config';

const profiles = loadProfiles(join(process.cwd(), 'resources', 'strategies', 'z2k-profiles.txt'));

test('профили z2k: размеры пулов как в README z2k', () => {
  const sizes = Object.fromEntries((['rkn_tcp', 'yt_tcp', 'gv_tcp', 'quic', 'discord_udp', 'http_rkn'] as const).map((p) => [p, strategyNumbers(profiles, p).length]));
  assert.deepEqual(sizes, { rkn_tcp: 50, yt_tcp: 22, gv_tcp: 22, quic: 9, discord_udp: 6, http_rkn: 8 });
  assert.deepEqual(profiles.map((p) => p.name), ['rkn_template', 'rkn_tcp', 'yt_tcp', 'gv_tcp', 'quic', 'discord_udp', 'http_rkn', 'wa_noise']);
});

test('одна стратегия: только её инстансы, без circular и без strategy=', () => {
  const prof = singleStrategyProfile(profiles, 'rkn_tcp', 1, ['--hostlist-domains=example.com'])!;
  const desync = prof.filter((t) => t.startsWith('--lua-desync='));
  assert.equal(desync.length, strategyLines(profiles, 'rkn_tcp', 1).length);
  assert.ok(desync.every((t) => !t.includes('circular') && !t.includes(':strategy=')));
  assert.ok(prof.includes('--hostlist-domains=example.com'));
  assert.ok(!prof.some((t) => t.startsWith('--hostlist=') || t.startsWith('--import')));
  const yt = singleStrategyProfile(profiles, 'yt_tcp', 3, [])!;
  assert.ok(yt.includes('--payload=tls_client_hello'));
});

test('своя строка заменяет пул и убирает шаблон RKN', () => {
  const custom = parseCustomStrategy('# комментарий\nwinws2 --lua-desync=multisplit:pos=1\n  --lua-desync=fake:blob=stun  # хвост');
  assert.deepEqual(custom, ['--lua-desync=multisplit:pos=1', '--lua-desync=fake:blob=stun']);
  const out = applyCustom(profiles, 'rkn_tcp', custom);
  assert.ok(!out.some((p) => p.name === 'rkn_template'));
  const rkn = out.find((p) => p.name === 'rkn_tcp')!;
  assert.ok(rkn.tokens.some((t) => t.startsWith('--hostlist=')));
  assert.ok(!rkn.tokens.some((t) => t.includes('circular')));
});

test('obfuscated2: DC и транспорт извлекаются из init клиента', () => {
  for (const dc of [2, -4, 5]) {
    const { wire } = makeClientInit(dc, TAG_INTERMEDIATE);
    const init = parseInit(wire)!;
    assert.equal(init.dc, dc);
    assert.equal(init.transport, 'intermediate');
  }
  assert.equal(parseInit(Buffer.alloc(64)), null);
});

test('нарезка потока на пакеты (intermediate и abridged), куски приходят произвольно', () => {
  for (const tag of [TAG_INTERMEDIATE, TAG_ABRIDGED]) {
    const { wire, encryptor } = makeClientInit(2, tag);
    const packets = [8, 64, 1000, 4].map((n) => {
      const body = Buffer.alloc(n * 4, n);
      let hdr: Buffer;
      if (tag === TAG_INTERMEDIATE) { hdr = Buffer.alloc(4); hdr.writeUInt32LE(body.length); }
      else hdr = n < 0x7f ? Buffer.from([n]) : Buffer.from([0x7f, n & 0xff, (n >> 8) & 0xff, 0]);
      return encryptor.update(Buffer.concat([hdr, body]));
    });
    const splitter = new PacketSplitter(parseInit(wire)!);
    const stream = Buffer.concat(packets);
    const got: Buffer[] = [];
    for (let i = 0; i < stream.length; i += 97) got.push(...splitter.push(stream.subarray(i, i + 97)));
    assert.equal(got.length, 4);
    got.forEach((g, i) => assert.ok(g.equals(packets[i])));
    assert.equal(splitter.rest(), null);
  }
});

test('подсети Telegram', () => {
  assert.ok(isTelegramIp('149.154.167.51'));
  assert.ok(isTelegramIp('91.108.56.130'));
  assert.ok(isTelegramIp('2001:b28:f23d:f001::a'));
  assert.ok(!isTelegramIp('8.8.8.8'));
});

test('домены: нормализация и фильтр Google', () => {
  assert.equal(normalizeDomain('https://www.Example.com/path?q=1'), 'example.com');
  assert.equal(normalizeDomain('*.sub.site.org.'), 'sub.site.org');
  assert.equal(normalizeDomain('не домен'), null);
  assert.ok(domainCovers('youtube.com', 'm.youtube.com'));
  assert.ok(!domainCovers('youtube.com', 'notyoutube.com'));
  assert.deepEqual(filterGoogle(['google.com', 'meet.google.com', 'mail.google.com', 'api.github.com', 'youtube.com']), ['meet.google.com', 'youtube.com']);
});

test('экранирование аргументов для @config (wordexp)', () => {
  assert.equal(quoteArg('--hostlist=C:/a/b.txt'), '--hostlist=C:/a/b.txt');
  assert.equal(quoteArg("--hostlist=C:/Program Files/x's.txt"), String.raw`'--hostlist=C:/Program Files/x'\''s.txt'`);
});

import { addrOk, domainOk, classify } from '../src/warp/lists';

test('WARP: фильтр адресов и доменов как z2k-warp-list-filter.awk', () => {
  assert.ok(addrOk('104.16.0.0/13') && addrOk('8.8.8.8'));
  for (const bad of ['10.0.0.0/8', '192.168.1.1', '127.0.0.1', '172.20.0.0/16', '100.64.0.1', '224.0.0.1', '0.1.2.3', '1.2.3.4/33', '01.2.3.4']) assert.ok(!addrOk(bad), bad);
  assert.ok(domainOk('game.example.com') && domainOk('*.example.net'));
  for (const bad of ['*.*.com', 'a.b*', 'localhost', 'ex ample.com', 'example.123']) assert.ok(!domainOk(bad), bad);
  const c = classify('# c\n1.2.3.0/24\nGame.Example.com\n10.0.0.1\n\n');
  assert.deepEqual(c, { ips: ['1.2.3.0/24'], domains: ['game.example.com'], invalid: ['10.0.0.1'] });
});

import { exitReason } from '../src/warp/manager';

test('WARP: причина падения движка понятным текстом', () => {
  const conflict = exitReason(['2026/10/01 16:50:15 Creating adapter', 'tun z2k-warp: set address: The object already exists.'], 1);
  assert.match(conflict, /172\.16\.0\.2 уже занят/);
  assert.match(exitReason(['fatal: no_endpoint'], 1), /Провайдер режет WARP/);
  assert.equal(exitReason([], 3), 'Движок завершился (код 3)');
});

import { cidrOverlap } from '../src/warp/manager';

test('WARP: пересечение префиксов (защита от петли через узлы WARP)', () => {
  assert.ok(cidrOverlap('162.159.192.5/32', '162.159.192.0/24'));
  assert.ok(cidrOverlap('8.0.0.0/8', '8.6.112.0/24'));
  assert.ok(cidrOverlap('188.114.96.0/21', '188.114.99.1'));
  assert.ok(!cidrOverlap('1.0.0.1/32', '162.159.192.0/24'));
  assert.ok(!cidrOverlap('8.7.0.0/16', '8.6.112.0/24'));
});
