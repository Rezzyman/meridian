#!/usr/bin/env node
/**
 * Cross-channel continuity check (WS5d / WS8). Encodes one fact through the
 * gateway, then asks for it on a fresh request and expects it back. Run on a
 * shadow gateway (or a bench clone) only; it writes one memory.
 *
 *   GATEWAY_URL=http://127.0.0.1:28889 GATEWAY_TOKEN=... node scripts/ops/continuity-check.mjs
 */
const base = (process.env.GATEWAY_URL ?? '').replace(/\/$/, '');
const token = process.env.GATEWAY_TOKEN;
if (!base || !token) {
  console.error('GATEWAY_URL and GATEWAY_TOKEN are required');
  process.exit(2);
}
const marker = `zephyr-${Math.random().toString(36).slice(2, 8)}`;
const ask = async (input) => {
  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()).reply ?? '';
};
console.log(`encode: remember that the continuity marker is ${marker}`);
await ask(`Please remember this exact phrase, it matters: the continuity marker is ${marker}.`);
await new Promise((r) => setTimeout(r, 4000));
const answer = await ask('What is the continuity marker I told you about?');
const ok = answer.toLowerCase().includes(marker);
console.log(`recall: ${answer.slice(0, 200).replace(/\n/g, ' ')}`);
console.log(ok ? 'CONTINUITY PASS' : 'CONTINUITY FAIL');
process.exit(ok ? 0 : 1);
