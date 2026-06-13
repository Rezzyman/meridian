/**
 * compare-harnesses — render the memory-poisoning POSTURE MATRIX across agent
 * harnesses from PUBLISHED behavior only. Reads the cited evidence table
 * (harness-claims.json) and prints a matrix + per-harness notes + the
 * disclaimer. It never runs, clones, or benchmarks any competitor's code — see
 * docs/harness-comparison-methodology.md for why that would be dishonest.
 *
 * The data (cited claims) and this renderer are deliberately separate: the
 * argument is the EVIDENCE, not the code. To challenge a cell, open its `source`
 * and PR a better citation into harness-claims.json.
 *
 *   npx tsx scripts/mempoison/compare-harnesses.mts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

type Value = 'yes' | 'partial' | 'no' | 'unpublished';
interface Claim {
  value: Value;
  evidence: string;
  source?: string;
  sourceType?: string;
  confidence?: string;
}
interface Harness {
  name: string;
  summary: string;
  claims: Record<string, Claim>;
}
interface Catalog {
  about: string;
  methodologyDoc: string;
  asOf: string;
  dimensions: Array<{ key: string; label: string; question: string }>;
  harnesses: Harness[];
}

const HERE = import.meta.dirname;
const catalog: Catalog = JSON.parse(readFileSync(join(HERE, 'harness-claims.json'), 'utf8'));

const GLYPH: Record<Value, string> = {
  yes: '✅ yes',
  partial: '🟡 partial',
  no: '⛔ no',
  unpublished: '· unpublished',
};

function main(): void {
  const L: string[] = [];
  L.push('# Memory-poisoning posture across agent harnesses');
  L.push('');
  L.push(`_As of ${catalog.asOf}. Methodology: ${catalog.methodologyDoc}._`);
  L.push('');
  L.push('> **Read this first.** Cells are scored from each harness\'s **published**');
  L.push('> behavior. `· unpublished` means *no public evidence either way* — it is');
  L.push('> **not** a claim that the capability is absent. We did not run, clone, or');
  L.push('> benchmark any competitor; doing so would measure our wiring of their code,');
  L.push('> not their defense. The only competitor *weaknesses* shown as `⛔ no` are');
  L.push('> ones an independent paper or the maintainer documented, and they are cited.');
  L.push('');

  // ── Matrix ──
  const header = ['Dimension', ...catalog.harnesses.map((h) => h.name)];
  L.push(`| ${header.join(' | ')} |`);
  L.push(`|${header.map(() => '---').join('|')}|`);
  for (const d of catalog.dimensions) {
    const row = [d.label, ...catalog.harnesses.map((h) => GLYPH[h.claims[d.key]?.value ?? 'unpublished'])];
    L.push(`| ${row.join(' | ')} |`);
  }
  L.push('');

  // ── Per-harness published-capability tally (NOT a rank) ──
  L.push('## Published-capability tally');
  L.push('');
  L.push('Count of dimensions each harness can show as `yes` **in public** (a measure of');
  L.push('what is documented, not of true security — an `unpublished` harness may defend');
  L.push('in ways it never wrote down):');
  L.push('');
  L.push('| harness | published `yes` | published `no` | unpublished |');
  L.push('|---|---|---|---|');
  for (const h of catalog.harnesses) {
    const vals = catalog.dimensions.map((d) => h.claims[d.key]?.value ?? 'unpublished');
    const yes = vals.filter((v) => v === 'yes').length;
    const no = vals.filter((v) => v === 'no').length;
    const unp = vals.filter((v) => v === 'unpublished').length;
    L.push(`| ${h.name} | ${yes}/${catalog.dimensions.length} | ${no} | ${unp} |`);
  }
  L.push('');

  // ── The single defensible headline ──
  const meridian = catalog.harnesses.find((h) => h.name === 'MERIDIAN');
  const others = catalog.harnesses.filter((h) => h.name !== 'MERIDIAN');
  const noOpenBench = others.every((h) => (h.claims.open_benchmark?.value ?? 'unpublished') !== 'yes');
  const meridianHasBench = meridian?.claims.open_benchmark?.value === 'yes';
  L.push('## The one defensible headline');
  L.push('');
  if (meridianHasBench && noOpenBench) {
    L.push('Among the surveyed harnesses, **MERIDIAN is the only one with an open,');
    L.push('reproducible memory-poisoning benchmark and a published signed-provenance +');
    L.push('multilingual recall-stage defense.** This is a statement about the *public');
    L.push('record* — reproducible by reading the cited sources — and it asserts nothing');
    L.push('about whether any competitor is insecure, only that none has published a');
    L.push('comparable defense or benchmark. If one does, this matrix gains a column and');
    L.push('the headline changes.');
  } else {
    L.push('_(Headline conditions not met by the current data — re-derive from the matrix.)_');
  }
  L.push('');

  // ── Evidence appendix (every non-trivial cell, cited) ──
  L.push('## Evidence (every cell, traceable)');
  L.push('');
  for (const h of catalog.harnesses) {
    L.push(`### ${h.name}`);
    L.push('');
    L.push(`_${h.summary}_`);
    L.push('');
    for (const d of catalog.dimensions) {
      const c = h.claims[d.key];
      if (!c) continue;
      const src = c.source ? ` — [source](${c.source})` : c.sourceType ? ` — (${c.sourceType})` : '';
      const conf = c.confidence ? ` _[confidence: ${c.confidence}]_` : '';
      L.push(`- **${d.label}: ${GLYPH[c.value]}** — ${c.evidence}${src}${conf}`);
    }
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('_Generated by `scripts/mempoison/compare-harnesses.mts` from the cited table');
  L.push('`scripts/mempoison/harness-claims.json`. OSS security posture moves weekly —');
  L.push('re-verify each `source` before using any cell in launch material._');

  const report = L.join('\n');
  console.log(report);
  const outDir =
    process.env.MEMPOISON_OUT_DIR ?? join(process.env.HOME ?? '.', 'meridian-parity-build-2026-06-11');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'harness-comparison.md'), report);
}

main();
