#!/usr/bin/env node
// Test entry that works on every supported Node (engines >=20). Node only
// learned to glob-expand a quoted --test pattern in v21, so the previous
// package.json glob silently broke the Node 20 CI leg: the runner treats the
// pattern as a literal path, finds nothing, and fails with "Could not find".
// (The Release workflow pins Node 22, which globs fine — which is how the
// break stayed invisible while releases kept publishing.)
//
// This walks test/ itself and hands `node --test` an explicit file list,
// which every supported version understands. The zero-file guard means an
// empty or mis-walked tree can never masquerade as a green suite.
//
// (Line comments on purpose: the glob pattern contains an asterisk-slash,
// which would terminate a block comment mid-pattern.)
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.test.ts')) files.push(p);
  }
};
walk('test');
files.sort();

if (files.length === 0) {
  console.error('run-tests: no *.test.ts files found under test/ — refusing to report green on nothing');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', '--import', 'tsx', ...files], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
