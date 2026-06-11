/**
 * Verification runtime tests (src/verification/runtime.ts).
 *
 * These functions are currently unwired (no runtime callers); the tests lock
 * the contract: loadChecks file parsing, runChecks per-helper semantics and
 * trigger filtering, and blocking() severity filtering.
 *
 * loadChecks takes a hand-rolled MeridianHome whose layer() points into a
 * per-run tmpdir — no ~/.meridian, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MeridianHome } from '../../src/config/home.js';
import { VerificationCheckSchema, type VerificationCheck } from '../../src/config/schema.js';
import { blocking, loadChecks, runChecks } from '../../src/verification/runtime.js';
import type { CheckResult, VerificationContext } from '../../src/verification/runtime.js';

// ─── Local helpers ───────────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), 'meridian-verification-test-'));
let n = 0;

/** Hand-rolled home: only layer() is used by loadChecks. */
function makeHome(): { home: MeridianHome; verificationDir: string } {
  const agentRoot = join(root, `case-${n++}`);
  const verificationDir = join(agentRoot, 'VERIFICATION');
  const home = { layer: (name: string) => join(agentRoot, name) } as unknown as MeridianHome;
  return { home, verificationDir };
}

/** Same shape, but with the VERIFICATION dir actually created. */
function makeHomeWithDir(): { home: MeridianHome; verificationDir: string } {
  const made = makeHome();
  mkdirSync(made.verificationDir, { recursive: true });
  return made;
}

/** Valid check with schema defaults applied; override per test. */
function makeCheck(overrides: Record<string, unknown> = {}): VerificationCheck {
  return VerificationCheckSchema.parse({
    name: 'check',
    skill: 'test-skill',
    helper: 'custom',
    ...overrides,
  });
}

function ctx(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return { output: 'plain output', ...overrides };
}

/** Run a single check against a context and return its one result. */
function runOne(check: VerificationCheck, c: VerificationContext): CheckResult {
  const results = runChecks([check], c);
  assert.equal(results.length, 1);
  return results[0];
}

// ─── loadChecks ──────────────────────────────────────────────────────────────

test('loadChecks: missing VERIFICATION dir returns []', () => {
  const { home } = makeHome();
  assert.deepEqual(loadChecks(home), []);
});

test('loadChecks: empty VERIFICATION dir returns []', () => {
  const { home } = makeHomeWithDir();
  assert.deepEqual(loadChecks(home), []);
});

test('loadChecks: valid .checks.md loads checks with schema defaults applied', () => {
  const { home, verificationDir } = makeHomeWithDir();
  writeFileSync(
    join(verificationDir, 'email.checks.md'),
    [
      '---',
      'checks:',
      '  - name: no-pii',
      '    skill: email',
      '    helper: pii_redaction',
      '    severity: block',
      '    trigger: always',
      '  - name: tone-default',
      '    skill: email',
      '    helper: tone_match',
      '---',
      '',
      '# Email verification notes',
    ].join('\n'),
  );

  const checks = loadChecks(home);
  assert.equal(checks.length, 2);

  const [pii, tone] = checks;
  assert.deepEqual(pii, {
    name: 'no-pii',
    skill: 'email',
    helper: 'pii_redaction',
    severity: 'block',
    trigger: 'always',
    config: {},
  });
  // Defaults: trigger on_output, severity warn, config {}
  assert.deepEqual(tone, {
    name: 'tone-default',
    skill: 'email',
    helper: 'tone_match',
    severity: 'warn',
    trigger: 'on_output',
    config: {},
  });
});

test('loadChecks: config record passes through from frontmatter', () => {
  const { home, verificationDir } = makeHomeWithDir();
  writeFileSync(
    join(verificationDir, 'tone.checks.md'),
    [
      '---',
      'checks:',
      '  - name: friendly',
      '    skill: support',
      '    helper: tone_match',
      '    config:',
      '      required_tone: thanks',
      '---',
    ].join('\n'),
  );

  const checks = loadChecks(home);
  assert.equal(checks.length, 1);
  assert.deepEqual(checks[0].config, { required_tone: 'thanks' });
});

test('loadChecks: file without frontmatter is skipped', () => {
  const { home, verificationDir } = makeHomeWithDir();
  writeFileSync(join(verificationDir, 'plain.checks.md'), '# no frontmatter here\nchecks: nope\n');
  assert.deepEqual(loadChecks(home), []);
});

test('loadChecks: invalid YAML in frontmatter is skipped without throwing', () => {
  const { home, verificationDir } = makeHomeWithDir();
  writeFileSync(
    join(verificationDir, 'broken.checks.md'),
    '---\nchecks: [unclosed\n---\nbody\n',
  );
  assert.deepEqual(loadChecks(home), []);
});

test('loadChecks: frontmatter where checks is not an array is skipped', () => {
  const { home, verificationDir } = makeHomeWithDir();
  writeFileSync(join(verificationDir, 'scalar.checks.md'), '---\nchecks: just-a-string\n---\n');
  assert.deepEqual(loadChecks(home), []);
});

test('loadChecks: invalid check entries are dropped, valid siblings still load', () => {
  const { home, verificationDir } = makeHomeWithDir();
  writeFileSync(
    join(verificationDir, 'mixed.checks.md'),
    [
      '---',
      'checks:',
      '  - name: missing-helper', // fails schema (no helper/skill)
      '  - name: valid-one',
      '    skill: ops',
      '    helper: factual_check',
      '---',
    ].join('\n'),
  );

  const checks = loadChecks(home);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].name, 'valid-one');
});

test('loadChecks: non-.checks.md files are ignored', () => {
  const { home, verificationDir } = makeHomeWithDir();
  const valid = [
    '---',
    'checks:',
    '  - name: should-not-load',
    '    skill: x',
    '    helper: custom',
    '---',
  ].join('\n');
  writeFileSync(join(verificationDir, 'notes.md'), valid);
  writeFileSync(join(verificationDir, 'checks.yaml'), valid);
  writeFileSync(join(verificationDir, 'README.txt'), 'readme');
  assert.deepEqual(loadChecks(home), []);
});

test('loadChecks: aggregates checks across multiple .checks.md files', () => {
  const { home, verificationDir } = makeHomeWithDir();
  const file = (name: string) =>
    ['---', 'checks:', `  - name: ${name}`, '    skill: s', '    helper: custom', '---'].join('\n');
  writeFileSync(join(verificationDir, 'a.checks.md'), file('from-a'));
  writeFileSync(join(verificationDir, 'b.checks.md'), file('from-b'));

  const names = loadChecks(home)
    .map((c) => c.name)
    .sort();
  assert.deepEqual(names, ['from-a', 'from-b']);
});

// ─── runChecks: pii_redaction ────────────────────────────────────────────────

test('pii_redaction: table of outputs', () => {
  const check = makeCheck({ name: 'pii', helper: 'pii_redaction', severity: 'block' });
  const cases: Array<{ output: string; passed: boolean; label: string }> = [
    { output: 'SSN is 123-45-6789, do not share', passed: false, label: 'SSN' },
    { output: 'card 4111111111111111 on file', passed: false, label: '16-digit CC' },
    { output: 'call 555-123-4567 today', passed: false, label: 'phone with dashes' },
    { output: 'call 5551234567 today', passed: false, label: 'bare 10-digit phone' },
    { output: 'all clear, nothing sensitive here', passed: true, label: 'clean output' },
    // Email addresses are NOT covered by PII_PATTERNS — passes per code.
    { output: 'reach me at jane.doe@example.com', passed: true, label: 'email not matched' },
  ];
  for (const c of cases) {
    const r = runOne(check, ctx({ output: c.output }));
    assert.equal(r.passed, c.passed, c.label);
    if (!c.passed) {
      assert.match(r.note ?? '', /PII pattern detected/, c.label);
    } else {
      assert.equal(r.note, undefined, c.label);
    }
  }
});

// ─── runChecks: tone_match ───────────────────────────────────────────────────

test('tone_match: fails when required_tone marker absent, case-insensitive match passes', () => {
  const check = makeCheck({
    name: 'tone',
    helper: 'tone_match',
    config: { required_tone: 'Thank You' },
  });

  const miss = runOne(check, ctx({ output: 'Here is the report.' }));
  assert.equal(miss.passed, false);
  assert.equal(miss.note, "Tone marker 'Thank You' not present");

  const hit = runOne(check, ctx({ output: 'THANK YOU for waiting — report attached.' }));
  assert.equal(hit.passed, true);
});

test('tone_match: passes when no required_tone configured', () => {
  const check = makeCheck({ name: 'tone', helper: 'tone_match' });
  assert.equal(runOne(check, ctx({ output: 'anything at all' })).passed, true);
});

// ─── runChecks: factual_check ────────────────────────────────────────────────

test('factual_check: hedge words fail, confident output passes', () => {
  const check = makeCheck({ name: 'facts', helper: 'factual_check' });
  const hedges = ['Maybe revenue grew', 'I think it shipped', 'It probably works', 'It might fail'];
  for (const output of hedges) {
    const r = runOne(check, ctx({ output }));
    assert.equal(r.passed, false, output);
    assert.equal(r.note, 'Output contains factual hedges; review before sending');
  }
  assert.equal(runOne(check, ctx({ output: 'Revenue grew 12% in Q2.' })).passed, true);
});

// ─── runChecks: numeric_validation ───────────────────────────────────────────

test('numeric_validation: must_contain_numbers enforces a digit in output', () => {
  const check = makeCheck({
    name: 'numbers',
    helper: 'numeric_validation',
    config: { must_contain_numbers: true },
  });

  const miss = runOne(check, ctx({ output: 'no figures provided' }));
  assert.equal(miss.passed, false);
  assert.equal(miss.note, 'Expected numeric content not found');

  assert.equal(runOne(check, ctx({ output: 'grew by 7 points' })).passed, true);
});

test('numeric_validation: passes without digits when must_contain_numbers unset', () => {
  const check = makeCheck({ name: 'numbers', helper: 'numeric_validation' });
  assert.equal(runOne(check, ctx({ output: 'no digits anywhere' })).passed, true);
});

// ─── runChecks: policy_compliance ────────────────────────────────────────────

test('policy_compliance: banned phrase fails case-insensitively when systemPolicy set', () => {
  const check = makeCheck({
    name: 'policy',
    helper: 'policy_compliance',
    config: { banned_phrases: ['guaranteed returns', 'risk-free'] },
  });

  const r = runOne(
    check,
    ctx({ output: 'This offers GUARANTEED RETURNS for everyone.', systemPolicy: 'no hype' }),
  );
  assert.equal(r.passed, false);
  assert.equal(r.note, "Banned phrase: 'guaranteed returns'");

  const clean = runOne(check, ctx({ output: 'Past performance varies.', systemPolicy: 'no hype' }));
  assert.equal(clean.passed, true);
});

test('policy_compliance: no-op (passes) when ctx.systemPolicy is absent', () => {
  const check = makeCheck({
    name: 'policy',
    helper: 'policy_compliance',
    config: { banned_phrases: ['guaranteed returns'] },
  });
  // Banned phrase present, but without systemPolicy the helper never inspects it.
  const r = runOne(check, ctx({ output: 'guaranteed returns for all!' }));
  assert.equal(r.passed, true);
});

// ─── runChecks: custom ───────────────────────────────────────────────────────

test('custom: stubbed to always pass in v0.1', () => {
  const check = makeCheck({ name: 'custom-stub', helper: 'custom', severity: 'block' });
  const r = runOne(check, ctx({ output: '123-45-6789 maybe risk-free' }));
  assert.equal(r.passed, true);
  assert.equal(r.note, undefined);
});

// ─── runChecks: trigger filtering ────────────────────────────────────────────

test('trigger on_tool_use: skipped (no result) when ctx has no toolCalls', () => {
  const check = makeCheck({ name: 'tool-only', helper: 'factual_check', trigger: 'on_tool_use' });
  assert.deepEqual(runChecks([check], ctx({ output: 'maybe' })), []);
  assert.deepEqual(runChecks([check], ctx({ output: 'maybe', toolCalls: [] })), []);
});

test('trigger on_tool_use: runs when toolCalls present', () => {
  const check = makeCheck({ name: 'tool-only', helper: 'factual_check', trigger: 'on_tool_use' });
  const results = runChecks(
    [check],
    ctx({ output: 'maybe done', toolCalls: [{ name: 'search', args: { q: 'x' } }] }),
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].passed, false);
});

test('triggers always and on_output run regardless of toolCalls', () => {
  const checks = [
    makeCheck({ name: 'always-check', helper: 'custom', trigger: 'always' }),
    makeCheck({ name: 'output-check', helper: 'custom', trigger: 'on_output' }),
  ];
  const without = runChecks(checks, ctx());
  assert.deepEqual(
    without.map((r) => r.name),
    ['always-check', 'output-check'],
  );
  const withTools = runChecks(checks, ctx({ toolCalls: [{ name: 't', args: {} }] }));
  assert.equal(withTools.length, 2);
});

// ─── runChecks: severity passthrough / result shape ──────────────────────────

test('severity passes through from check to result for both levels', () => {
  const results = runChecks(
    [
      makeCheck({ name: 'b', helper: 'custom', severity: 'block' }),
      makeCheck({ name: 'w', helper: 'custom', severity: 'warn' }),
    ],
    ctx(),
  );
  assert.deepEqual(results, [
    { name: 'b', passed: true, severity: 'block', note: undefined },
    { name: 'w', passed: true, severity: 'warn', note: undefined },
  ]);
});

test('runChecks preserves input order across mixed checks', () => {
  const checks = [
    makeCheck({ name: 'first', helper: 'pii_redaction' }),
    makeCheck({ name: 'second', helper: 'factual_check' }),
    makeCheck({ name: 'third', helper: 'custom' }),
  ];
  const results = runChecks(checks, ctx({ output: 'clean and confident' }));
  assert.deepEqual(
    results.map((r) => r.name),
    ['first', 'second', 'third'],
  );
});

// ─── blocking ────────────────────────────────────────────────────────────────

test('blocking: returns only failed block-severity results', () => {
  const results: CheckResult[] = [
    { name: 'failed-block', passed: false, severity: 'block', note: 'bad' },
    { name: 'failed-warn', passed: false, severity: 'warn', note: 'meh' },
    { name: 'passed-block', passed: true, severity: 'block' },
    { name: 'passed-warn', passed: true, severity: 'warn' },
    { name: 'failed-block-2', passed: false, severity: 'block' },
  ];
  assert.deepEqual(
    blocking(results).map((r) => r.name),
    ['failed-block', 'failed-block-2'],
  );
});

test('blocking: empty input returns []', () => {
  assert.deepEqual(blocking([]), []);
});
