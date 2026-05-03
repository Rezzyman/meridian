/**
 * Wearables lifelog backfill — observable, throttled, batch-sized.
 *
 * The naive "pull 60 days at once" approach hangs on Voyage quota
 * contention with the live agent's recall path. This version is smaller,
 * slower, and verbose so progress is visible per-lifelog and a single
 * problem doesn't stall the whole run.
 *
 * Run directly inside the meridian project:
 *   cd ~/meridian
 *   MERIDIAN_AGENT=<your-agent> pnpm exec tsx scripts/wearables-backfill.mts \
 *     --since 2026-02-17 --until 2026-05-02 \
 *     --batch-days 7 --throttle-ms 250
 *
 * Defaults: batch=7 days, throttle=250ms between encodes, since=last sync.
 * Idempotent — already-ingested lifelog ids are skipped.
 *
 * Best run when the live agent is idle. Voyage embeddings on a hot key
 * can hang the agent's recall by 3-5 minutes when both contend.
 */
import { ensureAgentHome } from '../src/config/home.js';
import { loadAgentEnv } from '../src/config/loader.js';
import { openAgentVault } from '../src/secrets/vault.js';
import { bindCortex } from '../src/cortex/bind.js';

interface Args {
  since?: string;
  until?: string;
  batchDays: number;
  throttleMs: number;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { batchDays: 7, throttleMs: 250, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--since') out.since = argv[++i];
    else if (a === '--until') out.until = argv[++i];
    else if (a === '--batch-days') out.batchDays = parseInt(argv[++i]!, 10);
    else if (a === '--throttle-ms') out.throttleMs = parseInt(argv[++i]!, 10);
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function fetchDay(apiKey: string, dayIso: string, cursor?: string): Promise<{
  lifelogs: Array<{ id: string; title?: string; markdown?: string; startTime?: string }>;
  nextCursor?: string;
}> {
  const url = new URL('https://api.limitless.ai/v1/lifelogs');
  url.searchParams.set('date', dayIso);
  url.searchParams.set('timezone', 'UTC');
  if (cursor) url.searchParams.set('cursor', cursor);
  const r = await fetch(url, { headers: { 'X-API-Key': apiKey, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Limitless ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = (await r.json()) as {
    data?: { lifelogs?: Array<{ id: string; title?: string; markdown?: string; startTime?: string }> };
    meta?: { lifelogs?: { nextCursor?: string } };
  };
  return { lifelogs: j.data?.lifelogs ?? [], nextCursor: j.meta?.lifelogs?.nextCursor };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

const args = parseArgs();
const home = ensureAgentHome(process.env.MERIDIAN_AGENT ?? (() => { throw new Error('MERIDIAN_AGENT env not set'); })());
const env = loadAgentEnv(home);
const cortex = bindCortex(env.CORTEX_AGENT_ID, env.MERIDIAN_CORTEX_URL);
const vault = openAgentVault({ envPath: home.envPath, vaultPath: home.vaultPath });

const apiKey = process.env.LIMITLESS_API_KEY;
if (!apiKey) throw new Error('LIMITLESS_API_KEY not set in process.env');

const ingestedIds = new Set<string>(vault.get<string[]>('skill.limitless.ingested_ids') ?? []);
const initialCount = ingestedIds.size;

const lastSync = vault.get<string>('skill.limitless.last_sync_at');
const since = args.since ? new Date(args.since) : lastSync ? new Date(lastSync) : new Date(Date.now() - args.batchDays * 24 * 3600 * 1000);
const until = args.until ? new Date(args.until) : new Date();

console.log(`[backfill] agent=${env.CORTEX_AGENT_ID} since=${isoDate(since)} until=${isoDate(until)} batch=${args.batchDays}d throttle=${args.throttleMs}ms dry=${args.dryRun}`);
console.log(`[backfill] already-ingested ids: ${initialCount}`);

const totalDays = Math.ceil((until.getTime() - since.getTime()) / (24 * 3600 * 1000));
console.log(`[backfill] ${totalDays} day(s) to process in ${Math.ceil(totalDays / args.batchDays)} batch(es)`);

const t0 = Date.now();
let totalSeen = 0;
let totalEncoded = 0;
let totalSkippedDuplicate = 0;
const errors: string[] = [];

for (let cursor = new Date(since); cursor <= until; ) {
  const batchEnd = new Date(Math.min(cursor.getTime() + args.batchDays * 24 * 3600 * 1000, until.getTime() + 1));
  console.log(`\n[backfill] batch ${isoDate(cursor)} → ${isoDate(new Date(batchEnd.getTime() - 1))}`);

  for (let day = new Date(cursor); day < batchEnd; day.setDate(day.getDate() + 1)) {
    const dayIso = isoDate(day);
    let pageCursor: string | undefined = undefined;
    let dayPagesProcessed = 0;
    let dayLifelogs = 0;
    let dayEncoded = 0;
    let dayDup = 0;

    for (let page = 0; page < 20; page++) {
      let resp: Awaited<ReturnType<typeof fetchDay>>;
      try {
        resp = await fetchDay(apiKey, dayIso, pageCursor);
      } catch (err) {
        const msg = `${dayIso} page ${page}: ${(err as Error).message}`;
        errors.push(msg);
        console.log(`  [error] ${msg}`);
        break;
      }
      dayPagesProcessed++;
      dayLifelogs += resp.lifelogs.length;
      totalSeen += resp.lifelogs.length;

      for (const lg of resp.lifelogs) {
        if (!lg.id) continue;
        if (ingestedIds.has(lg.id)) {
          dayDup++;
          totalSkippedDuplicate++;
          continue;
        }
        const body = (lg.markdown ?? '').trim();
        if (!body) continue;
        if (args.dryRun) {
          dayEncoded++;
          totalEncoded++;
          ingestedIds.add(lg.id);
          continue;
        }
        try {
          await cortex.encode(body, {
            source: `limitless:${dayIso}:${lg.id}`,
            priority: 2,
            sensitivity: 'internal',
          });
          ingestedIds.add(lg.id);
          dayEncoded++;
          totalEncoded++;
        } catch (err) {
          const msg = `encode ${lg.id}: ${(err as Error).message}`;
          errors.push(msg);
          console.log(`  [error] ${msg}`);
        }
        if (args.throttleMs > 0) await sleep(args.throttleMs);
      }

      pageCursor = resp.nextCursor;
      if (!pageCursor) break;
    }

    if (dayLifelogs === 0) {
      console.log(`  ${dayIso}: 0 lifelogs (empty day)`);
    } else {
      console.log(
        `  ${dayIso}: ${dayLifelogs} seen / ${dayEncoded} encoded / ${dayDup} skipped`,
      );
    }
  }

  // Persist progress after each batch — operator can interrupt and resume.
  if (!args.dryRun) {
    vault.setMany({
      'skill.limitless.ingested_ids': [...ingestedIds].slice(-50000),
      'skill.limitless.last_sync_at': new Date().toISOString(),
    });
  }
  cursor = new Date(batchEnd);
}

const elapsed = Math.round((Date.now() - t0) / 1000);
console.log(`\n[backfill] done in ${elapsed}s`);
console.log(`  total seen:    ${totalSeen}`);
console.log(`  total encoded: ${totalEncoded}`);
console.log(`  duplicates:    ${totalSkippedDuplicate}`);
console.log(`  errors:        ${errors.length}`);
console.log(`  ingested-ever: ${ingestedIds.size} (was ${initialCount})`);
if (errors.length) {
  console.log(`  first errors:`);
  for (const e of errors.slice(0, 5)) console.log(`    - ${e}`);
}
