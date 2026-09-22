#!/usr/bin/env node
/**
 * Loop synthetic canary (WS5d / WS8). Posts one aterna.loop.turn.v1 request
 * with fixed, non-personal evidence to a Loop endpoint and checks the reply
 * contract. Harness-agnostic: the endpoint can be the public sidecar
 * (https://webhook.aterna.ai/v1/loop/turns) or a Meridian gateway's own
 * /v1/loop/turns. Prints PASS/FAIL lines and exits non-zero on any failure.
 *
 *   LOOP_URL=https://webhook.aterna.ai/v1/loop/turns LOOP_TOKEN=<scoped bearer> node scripts/ops/loop-canary.mjs
 */
import { createHash, randomUUID } from 'node:crypto';

const url = process.env.LOOP_URL;
const token = process.env.LOOP_TOKEN;
if (!url || !token) {
  console.error('LOOP_URL and LOOP_TOKEN are required');
  process.exit(2);
}
const segmentId = randomUUID();
const excerpt = 'Canary note: the lawn service comes on Thursdays at nine in the morning.';
const evidence = [
  {
    lifelogId: randomUUID(),
    segmentId,
    startedAt: '2026-09-22T09:00:00Z',
    endedAt: '2026-09-22T09:01:00Z',
    excerpt,
    sha256: createHash('sha256').update(excerpt, 'utf8').digest('hex'),
  },
];
const frame = (v) =>
  Buffer.concat([
    Buffer.from(String(Buffer.byteLength(v, 'utf8'))),
    Buffer.from(':'),
    Buffer.from(v, 'utf8'),
  ]);
const corpus = createHash('sha256');
for (const e of evidence)
  for (const v of [e.lifelogId, e.segmentId, e.startedAt, e.endedAt, e.sha256])
    corpus.update(frame(v));
const body = {
  schemaVersion: 'aterna.loop.turn.v1',
  requestId: randomUUID(),
  threadId: randomUUID(),
  question: 'What day does the lawn service come?',
  sourceCorpusSha256: corpus.digest('hex'),
  intervalStart: '2026-09-22T00:00:00Z',
  intervalEnd: '2026-09-23T00:00:00Z',
  timeZoneIdentifier: 'America/Denver',
  evidence,
};
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const unauth = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
check(unauth.status === 401, 'unauthenticated request is 401', `(got ${unauth.status})`);
const t0 = Date.now();
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});
const ms = Date.now() - t0;
check(res.status === 200, 'authenticated request is 200', `(got ${res.status}, ${ms}ms)`);
let reply = {};
try {
  reply = await res.json();
} catch {
  check(false, 'reply is JSON');
}
check(reply.schemaVersion === 'aterna.loop.reply.v1', 'reply schema', reply.schemaVersion);
check(reply.requestId === body.requestId && reply.threadId === body.threadId, 'ids echoed');
check(
  reply.toolExecution === 'disabled' && reply.memoryWrite === 'disabled',
  'tools and memory writes disabled',
);
check(typeof reply.text === 'string' && reply.text.length > 0, 'non-empty text');
check(
  Array.isArray(reply.citedSegmentIds) && reply.citedSegmentIds.includes(segmentId),
  'cites the supplied segment',
  JSON.stringify(reply.citedSegmentIds),
);
check(/thursday/i.test(reply.text ?? ''), 'answer grounded in the evidence');
console.log(failures === 0 ? 'CANARY PASS' : `CANARY FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
