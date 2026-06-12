import { existsSync } from 'node:fs';
import { agentRoot } from './paths';

/** "June ☎️!" → "june" ; collisions get -2, -3, … */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || 'agent';
}

export function uniqueSlug(name: string): string {
  const base = slugify(name);
  if (!existsSync(agentRoot(base))) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!existsSync(agentRoot(candidate))) return candidate;
  }
  throw new Error(`could not find a free slug for "${name}"`);
}
