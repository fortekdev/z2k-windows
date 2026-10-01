import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aRecords, clientUdpSize, minTtl, parseQuestion, rewriteA, servfail, truncated } from '../src/dns/dnsmsg';

const name = (s: string) => Buffer.concat([...s.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
const query = (n: string, edns?: number) => Buffer.concat([
  Buffer.from([0xab, 0xcd, 1, 0, 0, 1, 0, 0, 0, 0, 0, edns ? 1 : 0]), name(n), Buffer.from([0, 1, 0, 1]),
  ...(edns ? [Buffer.from([0, 0, 41, edns >> 8, edns & 255, 0, 0, 0, 0, 0, 0])] : []),
]);
const a = (ip: string, ttl: number) => Buffer.concat([Buffer.from([0xc0, 12, 0, 1, 0, 1]), Buffer.from([ttl >> 24, ttl >> 16, ttl >> 8, ttl].map((x) => x & 255)), Buffer.from([0, 4]), Buffer.from(ip.split('.').map(Number))]);
const response = (n: string, ips: [string, number][]) => {
  const q = query(n);
  const r = Buffer.concat([q, ...ips.map(([ip, ttl]) => a(ip, ttl))]);
  r[2] = 0x81; r[3] = 0x80; r.writeUInt16BE(ips.length, 6);
  return r;
};

test('DNS: вопрос, EDNS-размер, TTL', () => {
  assert.deepEqual(parseQuestion(query('WWW.Instagram.com'))?.name, 'www.instagram.com');
  assert.equal(clientUdpSize(query('a.com')), 512);
  assert.equal(clientUdpSize(query('a.com', 1232)), 1232);
  assert.equal(minTtl(response('a.com', [['1.1.1.1', 300], ['1.0.0.1', 60]])), 60);
});

test('DNS: подмена A-записей по карте и поиск заглушек', () => {
  const r = response('www.instagram.com', [['157.240.205.174', 60], ['8.8.8.8', 60]]);
  const out = rewriteA(r, new Map([['157.240.205.174', '57.144.248.34']]))!;
  assert.deepEqual(aRecords(out), ['57.144.248.34', '8.8.8.8']);
  assert.equal(out.length, r.length);
  assert.equal(rewriteA(r, new Map([['9.9.9.9', '1.1.1.1']])), null);
  assert.deepEqual(aRecords(response('kinozal.tv', [['127.0.0.1', 60]])), ['127.0.0.1']);
});

test('DNS: TC-ответ и SERVFAIL сохраняют ID и вопрос', () => {
  const q = query('big.example.com');
  const r = response('big.example.com', [['1.2.3.4', 60]]);
  const t = truncated(r, parseQuestion(q)!);
  assert.equal(t[2] & 0x02, 0x02);
  assert.equal(t.readUInt16BE(6), 0);
  const sf = servfail(q);
  assert.equal(sf.readUInt16BE(0), 0xabcd);
  assert.equal(sf[3] & 0x0f, 2);
  assert.equal(parseQuestion(sf)?.name, 'big.example.com');
});
