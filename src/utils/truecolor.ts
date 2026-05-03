/**
 * 24-bit ANSI helpers with a 256-color fallback so the boot banner stays
 * brand-coloured everywhere — including Apple Terminal, which silently
 * strips truecolor escapes and otherwise gives us default white-on-black.
 */

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

// Detect once at module load. Truecolor is advertised via COLORTERM in every
// modern terminal that supports it (iTerm2, kitty, alacritty, gnome-terminal,
// VS Code, Warp). Apple Terminal sets neither so we fall back.
const SUPPORTS_TRUECOLOR = (() => {
  if (process.env.NO_COLOR) return false;
  const ct = (process.env.COLORTERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return true;
  // iTerm2 advertises itself; it always supports truecolor
  if (process.env.TERM_PROGRAM === 'iTerm.app') return true;
  return false;
})();

// 6×6×6 color cube index. Apple Terminal supports xterm-256, which maps
// RGB to a coarse cube. This rounds each channel into 0..5 then composes.
function to256(r: number, g: number, b: number): number {
  const ramp = (v: number): number => {
    if (v < 48) return 0;
    if (v < 115) return 1;
    return Math.min(5, Math.round((v - 35) / 40));
  };
  return 16 + 36 * ramp(r) + 6 * ramp(g) + ramp(b);
}

export function fg(r: number, g: number, b: number, text: string, bold = false): string {
  const b0 = bold ? BOLD : '';
  if (SUPPORTS_TRUECOLOR) {
    return `${b0}\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
  }
  return `${b0}\x1b[38;5;${to256(r, g, b)}m${text}${RESET}`;
}

export function gradient(
  lines: string[],
  from: [number, number, number],
  to: [number, number, number],
  bold = true,
): string[] {
  const n = Math.max(lines.length - 1, 1);
  return lines.map((line, i) => {
    const t = i / n;
    const r = Math.round(from[0] + (to[0] - from[0]) * t);
    const g = Math.round(from[1] + (to[1] - from[1]) * t);
    const b = Math.round(from[2] + (to[2] - from[2]) * t);
    return fg(r, g, b, line, bold);
  });
}

export const colors = {
  reset: RESET,
  bold: BOLD,
  dim: DIM,
  // Meridian brand
  cyan: (t: string) => fg(0, 212, 255, t, true),
  teal: (t: string) => fg(0, 184, 230, t, true),
  steel: (t: string) => fg(0, 160, 204, t),
  ink: (t: string) => fg(140, 175, 200, t),
  muted: (t: string) => fg(110, 140, 160, t),
  warn: (t: string) => fg(255, 184, 0, t, true),
  err: (t: string) => fg(255, 95, 95, t, true),
  ok: (t: string) => fg(120, 220, 160, t, true),
  // Layer-specific accents (used in boot panel)
  identity: (t: string) => fg(0, 212, 255, t, true),
  context: (t: string) => fg(120, 220, 240, t, true),
  skills: (t: string) => fg(180, 235, 240, t, true),
  memory: (t: string) => fg(0, 255, 200, t, true),
  connections: (t: string) => fg(255, 184, 0, t, true),
  verification: (t: string) => fg(220, 130, 255, t, true),
  automations: (t: string) => fg(255, 140, 200, t, true),
};
