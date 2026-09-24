import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { activeAgentSlug, ensureAgentHome } from '../config/home.js';
import { loadManifest } from '../certify/manifest.js';
import { certify, renderCard } from '../certify/runner.js';

/**
 * `meridian certify`: run the agent's capability manifest against a gateway.
 * Exit 0 certified, 1 not certified, 2 usage. Report written to
 * CAPABILITIES/certifications/<timestamp>.json in the agent home (or --out).
 */
export async function runCertify(opts: {
  gateway?: string;
  token?: string;
  manifest?: string;
  confirm?: string[];
  only?: string[];
  out?: string;
  json?: boolean;
}): Promise<number> {
  const slug = activeAgentSlug();
  const home = ensureAgentHome(slug);
  const manifestPath = opts.manifest ?? join(home.layer('CAPABILITIES'), 'manifest.yaml');
  if (!existsSync(manifestPath)) {
    console.error(
      `no manifest at ${manifestPath}. Write CAPABILITIES/manifest.yaml (see examples/arlo/CAPABILITIES/manifest.yaml).`,
    );
    return 2;
  }
  let token = opts.token;
  let gateway = opts.gateway;
  if (existsSync(home.envPath)) {
    const env = Object.fromEntries(
      readFileSync(home.envPath, 'utf8')
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [
          l.slice(0, l.indexOf('=')),
          l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, ''),
        ]),
    );
    token = token ?? env.MERIDIAN_GATEWAY_TOKEN;
    gateway = gateway ?? `http://127.0.0.1:${env.MERIDIAN_GATEWAY_PORT ?? '18889'}`;
    process.env.MERIDIAN_LOOP_TOKEN = process.env.MERIDIAN_LOOP_TOKEN ?? env.MERIDIAN_LOOP_TOKEN;
  }
  if (!gateway) {
    console.error('no gateway: pass --gateway http://127.0.0.1:<port>');
    return 2;
  }
  const manifest = loadManifest(manifestPath);
  const report = await certify(manifest, {
    gateway,
    token,
    manifestDir: dirname(manifestPath),
    confirmed: new Set(opts.confirm ?? []),
    only: opts.only,
    env: process.env,
  });
  const outDir = join(home.layer('CAPABILITIES'), 'certifications');
  const out = opts.out ?? join(outDir, `${report.ranAt.replace(/[:.]/g, '-')}.json`);
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  } catch {
    /* report still printed */
  }
  console.log(opts.json ? JSON.stringify(report, null, 2) : renderCard(report));
  console.log(`report: ${out}`);
  return report.certified ? 0 : 1;
}
