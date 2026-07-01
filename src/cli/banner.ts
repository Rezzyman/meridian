/**
 * MERIDIAN brand banner: solid sans-serif wordmark + sunburst rays.
 * Mirrors the official ATERNA Meridian wordmark color (sky-blue #1FA8FF).
 *
 * The wordmark uses solid full-block characters (█) with no outline,
 * so the result reads like the printed brand, not like figlet ascii art.
 *
 * Sunburst is rendered separately above and below so terminals that wrap
 * still get the wordmark intact.
 */

// boxen replaced with manual frameBox below for predictable whitespace handling
import { colors, fg, gradient } from '../utils/truecolor.js';
import type { CortexHealth, } from '../cortex/types.js';

// ─── "MERIDIAN" wordmark ──────────────────────────────────────────────────────
// 8 rows. Same proportions as the public ATERNA Meridian wordmark.
// Total width: ~74 cols.

export const MERIDIAN_WORDMARK_LINES: readonly string[] = [
  '███╗   ███╗  ███████╗  ██████╗   ██╗  ██████╗   ██╗   █████╗   ███╗   ██╗',
  '████╗ ████║  ██╔════╝  ██╔══██╗  ██║  ██╔══██╗  ██║  ██╔══██╗  ████╗  ██║',
  '██╔████╔██║  █████╗    ██████╔╝  ██║  ██║  ██║  ██║  ███████║  ██╔██╗ ██║',
  '██║╚██╔╝██║  █████╗    ██████╔╝  ██║  ██║  ██║  ██║  ███████║  ██╔██╗ ██║',
  '██║ ╚═╝ ██║  ██╔══╝    ██╔══██╗  ██║  ██║  ██║  ██║  ██╔══██║  ██║╚██╗██║',
  '██║     ██║  ███████╗  ██║  ██║  ██║  ██████╔╝  ██║  ██║  ██║  ██║ ╚████║',
  '██║     ██║  ███████╗  ██║  ██║  ██║  ██████╔╝  ██║  ██║  ██║  ██║ ╚████║',
  '╚═╝     ╚═╝  ╚══════╝  ╚═╝  ╚═╝  ╚═╝  ╚═════╝   ╚═╝  ╚═╝  ╚═╝  ╚═╝  ╚═══╝',
];

// ─── Narrow centered sunburst ─────────────────────────────────────────────────
// Concentrated at the wordmark's vertical eye (the center). One vertical spine
// up and down, with diagonals fanning a short distance from the same center.
// Does not span the full width of the wordmark. Burst-on-eye, not curtain.
//
// 9-point starburst. Each hemisphere fans 4 rays per side at varying angles
// (steep, medium-steep, medium-shallow, shallow) plus a long center spine
// and a far-edge dot for the near-horizontal extreme. Rays radiate from the
// eye implied at the wordmark center; lengths vary so the burst reads as a
// star with deliberate geometry, not a uniform fan.
//
// The wordmark is ~73 cols wide, eye at col ~35. Rays span 51 cols (cols
// ~10..60), 7 rows on top and 7 on bottom.

const EYE_PAD = 10;

const SUNBURST_TOP: readonly string[] = [
  `${' '.repeat(EYE_PAD)}                         │                         `,
  `${' '.repeat(EYE_PAD)}                      ╲  │  ╱                      `,
  `${' '.repeat(EYE_PAD)}                ╲        │        ╱                `,
  `${' '.repeat(EYE_PAD)}          ╲              │              ╱          `,
  `${' '.repeat(EYE_PAD)}   ╲                     │                     ╱   `,
  `${' '.repeat(EYE_PAD)} ·                       │                       · `,
  `${' '.repeat(EYE_PAD)}·                                                 ·`,
];

const SUNBURST_BOTTOM: readonly string[] = [
  `${' '.repeat(EYE_PAD)}·                                                 ·`,
  `${' '.repeat(EYE_PAD)} ·                       │                       · `,
  `${' '.repeat(EYE_PAD)}   ╱                     │                     ╲   `,
  `${' '.repeat(EYE_PAD)}          ╱              │              ╲          `,
  `${' '.repeat(EYE_PAD)}                ╱        │        ╲                `,
  `${' '.repeat(EYE_PAD)}                      ╱  │  ╲                      `,
  `${' '.repeat(EYE_PAD)}                         │                         `,
];

// ─── ATERNA brand mark for the boot panel left column ────────────────────────
// Compact perfectly-symmetric pyramid (5 rows, widths 1·3·5·7·9). "A·I"
// in row 4 takes 3 cells (with a brand-consistent middle dot) so it
// centers exactly: 2 ▲ left, A·I in the middle, 2 ▲ right. Cyan body,
// bright watermark for the letters.
export const ATERNA_MARK: readonly string[] = [
  '         ▲    ',
  '        ▲▲▲   ',
  '       ▲▲▲▲▲  ',
  '      ▲▲▲A·I▲ ',
  '     ▲▲▲▲▲▲▲▲▲',
  '              ',
  '   Aterna.AI™',
  ' Create Your Legend',
];

// ─── Brand gradient — tight band of the public Meridian sky-blue ─────────────
// All three stops live in the cyan-blue family. No washed-out top, no muddy
// bottom. The whole wordmark reads as one solid brand color.
const BRAND_TOP: [number, number, number] = [80, 200, 255];
const BRAND_MID: [number, number, number] = [31, 174, 255]; // brand core (#1FAEFF)
const BRAND_LOW: [number, number, number] = [0, 140, 230];

// Rays render in white so they read as light spilling out of the wordmark
// rather than another shade of brand cyan. Bright at the wordmark, fading to
// soft pearl at the outer edge so the burst has depth without going noisy.
const RAY_COLOR: [number, number, number] = [255, 255, 255];
const RAY_DIM: [number, number, number] = [170, 180, 200];

// ─── Renderers ─────────────────────────────────────────────────────────────────

function gradientThree(
  lines: readonly string[],
  top: [number, number, number],
  mid: [number, number, number],
  low: [number, number, number],
): string[] {
  const n = lines.length;
  return lines.map((line, i) => {
    const t = i / Math.max(1, n - 1);
    let c: [number, number, number];
    if (t < 0.5) {
      const k = t * 2;
      c = [
        Math.round(top[0] + (mid[0] - top[0]) * k),
        Math.round(top[1] + (mid[1] - top[1]) * k),
        Math.round(top[2] + (mid[2] - top[2]) * k),
      ];
    } else {
      const k = (t - 0.5) * 2;
      c = [
        Math.round(mid[0] + (low[0] - mid[0]) * k),
        Math.round(mid[1] + (low[1] - mid[1]) * k),
        Math.round(mid[2] + (low[2] - mid[2]) * k),
      ];
    }
    return fg(c[0], c[1], c[2], line, true);
  });
}

export function renderWordmark(): string {
  return gradientThree([...MERIDIAN_WORDMARK_LINES], BRAND_TOP, BRAND_MID, BRAND_LOW).join('\n');
}

export function renderSunburstTop(): string {
  // Rays go from dimmer at top (far from wordmark) to brighter near wordmark.
  return gradient([...SUNBURST_TOP], RAY_DIM, RAY_COLOR, false).join('\n');
}

export function renderSunburstBottom(): string {
  // Mirror: brightest near wordmark (top of bottom block), dimmest at far edge.
  return gradient([...SUNBURST_BOTTOM], RAY_COLOR, RAY_DIM, false).join('\n');
}

// ─── 9-point radial starburst (renders THROUGH the wordmark) ──────────────────
// The starburst is a single radial pattern that spans top + wordmark + bottom.
// Wordmark glyphs are layered on top so the rays peek through the gaps between
// letters and the spine runs floor-to-ceiling. This is the "halo" composite,
// distinct from the older split top/bottom strips.

const BURST_TOP_ROWS = 7;
const BURST_BOTTOM_ROWS = 7;
const BURST_PAD_LEFT = 1; // tiny breathing room before wordmark column 0

function buildRadialBurst(): { glyph: string; dist: number }[][] {
  const wmRows = MERIDIAN_WORDMARK_LINES.length; // 8
  const wmCols = Math.max(...MERIDIAN_WORDMARK_LINES.map((l) => l.length)); // 73
  const totalRows = BURST_TOP_ROWS + wmRows + BURST_BOTTOM_ROWS;
  const totalCols = wmCols + BURST_PAD_LEFT * 2;

  // grid[row][col] = { glyph, dist } where dist is distance-from-eye (for fade).
  const grid: { glyph: string; dist: number }[][] = Array.from({ length: totalRows }, () =>
    Array.from({ length: totalCols }, () => ({ glyph: ' ', dist: 0 })),
  );

  // Eye sits at the vertical center of the wordmark.
  const eyeRow = BURST_TOP_ROWS + Math.floor(wmRows / 2);
  const eyeCol = Math.floor(totalCols / 2);

  // "Light along the meridian" — the only bilaterally symmetric thing on
  // this canvas is the wordmark. The burst is deliberately irregular:
  // every angle is unique, every length is unique, the upper hemisphere
  // has more rays than the lower, and the long "kick" rays land on
  // OPPOSITE corners (upper-right + lower-left) so the eye reads it as
  // a diagonal sweep, not a radial star.
  const rays: { angleDeg: number; maxDist: number }[] = [
    // Dominant vertical meridian — long, the visual anchor.
    { angleDeg: 90, maxDist: 20 },
    { angleDeg: 270, maxDist: 20 },
    // One kick ray upper-right + matching kick lower-left (rotational, NOT
    // mirror). This is what gives the burst a "spin".
    { angleDeg: 28, maxDist: 14 },
    { angleDeg: 208, maxDist: 14 },
    // Short scatter at irregular angles — every angle distinct, every
    // length under half the spine so the meridian stays dominant.
    { angleDeg: 138, maxDist: 9 },   // upper-left
    { angleDeg: 322, maxDist: 8 },   // lower-right
    { angleDeg: 165, maxDist: 11 },  // upper-left far (shallow)
    { angleDeg: 78, maxDist: 5 },    // upper-right inner spark
    { angleDeg: 245, maxDist: 6 },   // lower-left short
    // Atmosphere dots in the unfilled quadrants only, balancing the
    // visual weight without adding more "rays" per se.
    { angleDeg: 355, maxDist: 36 },
    { angleDeg: 185, maxDist: 30 },
  ];

  for (const ray of rays) {
    const rad = (ray.angleDeg * Math.PI) / 180;
    const dx = Math.cos(rad);
    // Cell aspect ratio: characters are ~2:1 (height:width). Halve dy so
    // visual angles match what the user perceives, not raw cell deltas.
    const dy = -Math.sin(rad) * 0.5;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);

    // Pick glyph by exact angle so 65–85° / 95–115° etc still render as
    // diagonals (`╲`/`╱`) instead of getting collapsed into vertical bars
    // adjacent to the spine.
    const a = ((ray.angleDeg % 360) + 360) % 360;
    const isVertical = Math.abs(a - 90) < 8 || Math.abs(a - 270) < 8;
    const isHorizontal = absX > absY * 4;
    let glyph: string;
    if (isVertical) glyph = '│';
    else if (isHorizontal) glyph = '·';
    else if ((a > 0 && a < 90) || (a > 180 && a < 270)) glyph = '╱';
    else glyph = '╲';

    // Two stepping modes:
    //   1. Near-horizontal rays (absX > absY*4): step by col, place sparse
    //      dots every 5 cells so they read as deliberate sun-rays through
    //      the wordmark, not a solid horizontal bar.
    //   2. Everything else: step by row (one glyph per row) so verticals
    //      and diagonals never double up on the same row. Each row's col is
    //      computed from the per-ray cols-per-row slope.
    if (isHorizontal) {
      const sX = Math.sign(dx);
      const rowsPerCol = dy / absX;
      for (let i = 1; i <= ray.maxDist; i++) {
        const cIdx = eyeCol + i * sX;
        const r = eyeRow + Math.round(i * rowsPerCol);
        if (r < 0 || r >= totalRows || cIdx < 0 || cIdx >= totalCols) break;
        if (i % 5 !== 0) continue; // sparse dots only
        if (grid[r]![cIdx]!.glyph === ' ') {
          grid[r]![cIdx] = { glyph, dist: i };
        }
      }
    } else {
      const sY = Math.sign(dy);
      const colsPerRow = absY === 0 ? 0 : dx / absY;
      for (let i = 1; i <= ray.maxDist; i++) {
        const r = eyeRow + i * sY;
        const cIdx = eyeCol + Math.round(i * colsPerRow);
        if (r < 0 || r >= totalRows || cIdx < 0 || cIdx >= totalCols) break;
        if (grid[r]![cIdx]!.glyph === ' ') {
          grid[r]![cIdx] = { glyph, dist: i };
        }
      }
    }
  }

  // Overlay the wordmark glyphs on top of any ray glyphs in the wordmark band.
  for (let r = 0; r < wmRows; r++) {
    const line = MERIDIAN_WORDMARK_LINES[r]!;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]!;
      if (ch !== ' ') {
        grid[BURST_TOP_ROWS + r]![BURST_PAD_LEFT + c] = { glyph: ch, dist: -1 };
      }
    }
  }

  return grid;
}

function renderRadialBurst(): string {
  const grid = buildRadialBurst();
  const wmRows = MERIDIAN_WORDMARK_LINES.length;
  const out: string[] = [];
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r]!;
    let acc = '';
    for (let c = 0; c < row.length; c++) {
      const cell = row[c]!;
      if (cell.glyph === ' ') {
        acc += ' ';
        continue;
      }
      if (cell.dist < 0) {
        // Wordmark glyph — three-stop brand cyan gradient based on row position.
        const t = (r - BURST_TOP_ROWS) / Math.max(1, wmRows - 1);
        let col: [number, number, number];
        if (t < 0.5) {
          const k = t * 2;
          col = [
            Math.round(BRAND_TOP[0] + (BRAND_MID[0] - BRAND_TOP[0]) * k),
            Math.round(BRAND_TOP[1] + (BRAND_MID[1] - BRAND_TOP[1]) * k),
            Math.round(BRAND_TOP[2] + (BRAND_MID[2] - BRAND_TOP[2]) * k),
          ];
        } else {
          const k = (t - 0.5) * 2;
          col = [
            Math.round(BRAND_MID[0] + (BRAND_LOW[0] - BRAND_MID[0]) * k),
            Math.round(BRAND_MID[1] + (BRAND_LOW[1] - BRAND_MID[1]) * k),
            Math.round(BRAND_MID[2] + (BRAND_LOW[2] - BRAND_MID[2]) * k),
          ];
        }
        acc += fg(col[0], col[1], col[2], cell.glyph, true);
      } else {
        // Ray glyph — fade from bright at the eye to soft at the rim.
        const t = Math.min(1, cell.dist / 24);
        const cR = Math.round(RAY_COLOR[0] + (RAY_DIM[0] - RAY_COLOR[0]) * t);
        const cG = Math.round(RAY_COLOR[1] + (RAY_DIM[1] - RAY_COLOR[1]) * t);
        const cB = Math.round(RAY_COLOR[2] + (RAY_DIM[2] - RAY_COLOR[2]) * t);
        acc += fg(cR, cG, cB, cell.glyph, false);
      }
    }
    out.push(acc);
  }
  return out.join('\n');
}

export function renderLogo(): string {
  // New composite: rays drawn behind the wordmark so the burst is visible
  // floor-to-ceiling. The legacy split top/bottom strips are unused now.
  const burst = renderRadialBurst();
  // Headline + byline. "AGENT OS" is the product category claim, "by ATERNA AI"
  // is the maker mark. Centered roughly under the wordmark eye.
  const headline =
    '                  ' +
    colors.cyan('THE AGENT OS') +
    '   ' +
    colors.muted('· BY ATERNA AI');
  return [burst, '', headline].join('\n');
}

export function renderAternaMark(): string {
  // Pyramid in muted brand cyan (a shade dimmer than the MERIDIAN wordmark
  // so it stays subtle). Embedded `/`, `\`, `|`, `-` glyphs that form the
  // "AI" letters render in bright white so the carving reads as etched
  // text, not noise. Tagline below in muted gray.
  const c = colors;
  const TRI_TOP: [number, number, number] = [70, 175, 220];
  const TRI_LOW: [number, number, number] = [40, 130, 180];
  const ETCH: [number, number, number] = [230, 240, 250]; // bright white-cyan
  const TRIANGLE_ROWS = 5; // rows 0..4 are the pyramid (AI watermarked in row 3)
  const out: string[] = [];

  const isPyramidChar = (ch: string) => ch === '▲';
  // Anything alphanumeric (or the middle-dot brand separator) in a pyramid
  // row is treated as an etched letter, so the AI play renders bright
  // against the cyan body.
  const isEtchChar = (ch: string) => /[A-Za-z0-9/\\|_·-]/.test(ch);

  for (let i = 0; i < ATERNA_MARK.length; i++) {
    const line = ATERNA_MARK[i]!;
    if (i < TRIANGLE_ROWS) {
      const t = i / Math.max(1, TRIANGLE_ROWS - 1);
      const pr = Math.round(TRI_TOP[0] + (TRI_LOW[0] - TRI_TOP[0]) * t);
      const pg = Math.round(TRI_TOP[1] + (TRI_LOW[1] - TRI_TOP[1]) * t);
      const pb = Math.round(TRI_TOP[2] + (TRI_LOW[2] - TRI_TOP[2]) * t);
      // Per-character coloring so carved letters pop against the pyramid.
      let acc = '';
      let buf = '';
      let bufKind: 'pyramid' | 'etch' | 'space' = 'space';
      const flush = () => {
        if (!buf) return;
        if (bufKind === 'pyramid') acc += fg(pr, pg, pb, buf, true);
        else if (bufKind === 'etch') acc += fg(ETCH[0], ETCH[1], ETCH[2], buf, true);
        else acc += buf;
        buf = '';
      };
      for (const ch of line) {
        const kind: 'pyramid' | 'etch' | 'space' = isPyramidChar(ch)
          ? 'pyramid'
          : isEtchChar(ch)
            ? 'etch'
            : 'space';
        if (kind !== bufKind) {
          flush();
          bufKind = kind;
        }
        buf += ch;
      }
      flush();
      out.push(acc);
      continue;
    }
    // Below the pyramid:
    //   row 5 — blank separator
    //   row 6 — brand name "Aterna.AI™" in soft brand cyan
    //   row 7 — muted tagline ("Create Your Legend")
    if (i === 6) {
      out.push(fg(TRI_TOP[0], TRI_TOP[1], TRI_TOP[2], line, true));
    } else {
      out.push(c.muted(line));
    }
  }
  return out.join('\n');
}

// ─── Boot panel (cards on the right, glyph on the left) ───────────────────────

export interface SkillToggle {
  name: string;
  enabled: boolean;
}

export interface BootPanelData {
  version: string;
  releaseDate: string;
  agentSlug: string;
  agentName: string;
  /** Optional: small identity card under the ATERNA mark (model, cwd, session). */
  identity?: {
    agentRole?: string;
    model?: string;
    provider?: string;
    cwd: string;
    sessionId: string;
  };
  toolsByCategory: Record<string, string[]>;
  mcpServers: Array<{ name: string; transport: string; toolCount: number }>;
  /** Wired-up channels — what the agent can be reached on, branded explicitly. */
  channels?: Array<{ name: string; binding: string; status: 'live' | 'armed' | 'off' }>;
  /** Essential skills (10) — turned on out of the box. */
  essentialSkills: SkillToggle[];
  /** Bundled skill library (Hermes-compatible names + ours). Disabled by default. */
  skillLibrary: Record<string, string[]>;
  /** Layer presence: true = ready, false = not yet provisioned. */
  layerStatus: {
    identity: boolean;
    context: boolean;
    skills: boolean;
    memory: boolean;
    connections: boolean;
    verification: boolean;
    automations: boolean;
  };
  /** CORTEX status only (no fake stats; show counts only when truly known). */
  cortex: { status: CortexHealth['status']; database: CortexHealth['database']; memoryCount?: number; synapseCount?: number; lastDreamAt?: string };
  cwd: string;
  sessionId: string;
}

// Strip ANSI escape codes to compute visible width.
function visibleWidth(s: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes is the point
  return s.replace(/\x1b\[[0-9;]*m/g, '').replace(/ /g, ' ').length;
}

// Pad with non-breaking space so boxen never strips leading whitespace
// when the left column is empty. NBSP renders the same width as space.
function padRightVisible(s: string, target: number): string {
  const vw = visibleWidth(s);
  if (vw >= target) return s;
  return s + ' '.repeat(target - vw);
}

export function renderBootPanel(data: BootPanelData): string {
  const c = colors;
  const LEFT_W = 28;
  const RIGHT_W = 82;
  const left = renderAternaMark().split('\n');

  // Identity card under the pyramid — agent role, model · provider, cwd, session.
  // Same shape HERMES tucks into its sigil column; gives the boot screen a
  // grounded "this is the runtime, this is who is alive" anchor.
  if (data.identity) {
    const id = data.identity;
    left.push('');
    if (id.agentRole) {
      left.push(` ${c.steel(id.agentRole)}`);
    }
    if (id.model) {
      // Show the last `/`-segment so long model paths fit the left column.
      const modelShort = id.model.includes('/') ? id.model.split('/').pop()! : id.model;
      const provider = id.provider ? `  ${c.muted(`· ${id.provider}`)}` : '';
      left.push(` ${c.muted(modelShort)}${provider}`);
    }
    if (id.cwd) {
      const trimmed = id.cwd.length > 24 ? `…${id.cwd.slice(-23)}` : id.cwd;
      left.push(` ${c.muted(trimmed)}`);
    }
    if (id.sessionId) {
      // Truncate to the first 8 hex chars — enough to disambiguate at a glance.
      const shortId = id.sessionId.replace(/^t_/, '').slice(0, 8);
      left.push(` ${c.muted(`session ${shortId}`)}`);
    }
  }

  const right: string[] = [];

  // ─── Tools ──
  right.push(c.cyan('Tools'));
  for (const [cat, items] of Object.entries(data.toolsByCategory)) {
    right.push(`  ${c.steel(cat.padEnd(11, ' '))}  ${items.join(', ')}`);
  }
  right.push('');

  // ─── CORTEX status (no fake numbers) ──
  right.push(c.memory('CORTEX'));
  const cortexState = data.cortex.status === 'ok' ? c.ok('connected') : data.cortex.status === 'degraded' ? c.warn('degraded') : c.err('offline');
  right.push(`  ${c.muted('status'.padEnd(11, ' '))}  ${cortexState}`);
  if (typeof data.cortex.memoryCount === 'number' && data.cortex.memoryCount > 0) {
    right.push(`  ${c.muted('memories'.padEnd(11, ' '))}  ${data.cortex.memoryCount.toLocaleString()}`);
  }
  if (typeof data.cortex.synapseCount === 'number' && data.cortex.synapseCount > 0) {
    right.push(`  ${c.muted('synapses'.padEnd(11, ' '))}  ${data.cortex.synapseCount.toLocaleString()}`);
  }
  if (data.cortex.lastDreamAt) {
    right.push(`  ${c.muted('last dream'.padEnd(11, ' '))}  ${data.cortex.lastDreamAt}`);
  }
  right.push('');

  // ─── Layer status (single column, day-one-friendly labels) ──
  right.push(c.cyan('Layers'));
  const layerStates: Array<[string, boolean, string, string]> = [
    ['IDENTITY', data.layerStatus.identity, 'ready', 'set up'],
    ['CONTEXT', data.layerStatus.context, 'curated', 'add files when ready'],
    ['SKILLS', data.layerStatus.skills, 'loaded', 'no skills'],
    ['MEMORY', data.layerStatus.memory, 'cortex connected', 'cortex offline'],
    ['CONNECTIONS', data.layerStatus.connections, 'wired', 'add via /connect'],
    ['VERIFICATION', data.layerStatus.verification, 'defaults active', 'add checks'],
    ['AUTOMATIONS', data.layerStatus.automations, 'armed', 'add jobs'],
  ];
  for (const [name, state, onLabel, offLabel] of layerStates) {
    const dot = state ? c.ok('●') : c.muted('·');
    const tail = state ? c.muted(onLabel) : c.muted(offLabel);
    right.push(`  ${dot}  ${name.padEnd(13, ' ')}  ${tail}`);
  }
  right.push('');

  // ─── Channels (where the agent can be reached) ──
  if (data.channels?.length) {
    right.push(c.cyan('Channels'));
    for (const ch of data.channels) {
      const dot =
        ch.status === 'live' ? c.ok('●') : ch.status === 'armed' ? c.warn('●') : c.muted('·');
      const tag =
        ch.status === 'live'
          ? c.ok('live')
          : ch.status === 'armed'
            ? c.warn('armed')
            : c.muted('off');
      right.push(`  ${dot}  ${c.steel(ch.name.padEnd(18, ' '))}${c.muted(ch.binding.padEnd(28, ' '))}${tag}`);
    }
    right.push('');
  }

  // ─── MCP servers ──
  if (data.mcpServers.length) {
    right.push(c.cyan('MCP Servers'));
    for (const m of data.mcpServers) {
      right.push(`  ${m.name} (${m.transport})`);
    }
    right.push('');
  }

  // ─── Active skills (loaded from agent's SKILLS/ layer) ──
  // Honest section: only shows skills the agent ACTUALLY has loaded right
  // now. Empty + grayed-out when nothing is wired, never decorative.
  const hasLoaded = data.essentialSkills.some((s) => s.enabled);
  if (hasLoaded) {
    right.push(c.cyan('Active Skills') + c.muted('  ·  loaded from SKILLS/'));
    for (let i = 0; i < data.essentialSkills.length; i += 2) {
      const a = data.essentialSkills[i];
      const b = data.essentialSkills[i + 1];
      const renderOne = (s?: SkillToggle): string => {
        if (!s) return ' '.repeat(30);
        const tag = s.enabled ? c.ok('[on]') : c.muted('[off]');
        return `${tag}  ${s.name.padEnd(22, ' ')}`;
      };
      right.push(`  ${renderOne(a)}${renderOne(b)}`);
    }
  } else {
    right.push(c.cyan('Active Skills') + c.muted('  ·  none loaded — drop SKILLS/<name>/SKILL.md to add'));
  }
  right.push('');

  // ─── Skill catalog (NOT active — these are install candidates) ──
  // Renamed from "Skill Library" so users don't think these are wired.
  // Future: `meridian skills install <name>` will pull from this catalog.
  const libraryTotal = Object.values(data.skillLibrary).reduce((n, arr) => n + arr.length, 0);
  if (libraryTotal > 0) {
    right.push(
      c.cyan('Skill Catalog') +
        c.muted(`  ·  ${libraryTotal} planned  ·  roadmap, not yet bundled`),
    );
    for (const [cat, items] of Object.entries(data.skillLibrary)) {
      const head = items.slice(0, 3).join(', ');
      const more = items.length > 3 ? `  +${items.length - 3}` : '';
      const tail = head + more;
      const trimmed = visibleWidth(tail) > 50 ? `${tail.slice(0, 49)}…` : tail;
      right.push(`  ${c.steel(cat.padEnd(20, ' '))}  ${c.muted(trimmed)}`);
    }
    right.push('');
  }

  // Footer: report ACTIVE counts only, not catalog totals.
  const activeSkills = data.essentialSkills.filter((s) => s.enabled).length;
  const totalTools = Object.values(data.toolsByCategory).reduce((n, arr) => n + arr.length, 0);
  const catalogNote = libraryTotal > 0 ? ` · ${libraryTotal} catalog` : '';
  right.push(
    c.muted(
      `${totalTools} tools · ${activeSkills} active skill${activeSkills === 1 ? '' : 's'}${catalogNote} · ${data.mcpServers.length} MCP${data.mcpServers.length === 1 ? '' : 's'} · /help`,
    ),
  );

  // ─── Two-column merge ──
  // NBSP gap between columns so boxen doesn't compress runs of whitespace.
  const maxLines = Math.max(left.length, right.length);
  const merged: string[] = [];
  for (let i = 0; i < maxLines; i++) {
    const l = padRightVisible(left[i] ?? '', LEFT_W);
    const r = right[i] ?? '';
    merged.push(`${l}  ${r}`);
  }

  const title = ` Meridian v${data.version}  ·  ${data.releaseDate}  ·  ${data.agentName} `;
  return frameBox(merged, title, LEFT_W + 2 + RIGHT_W);
}

// ─── Manual box frame (replaces boxen for predictable whitespace handling) ──
function frameBox(lines: string[], title: string, contentWidth: number): string {
  const c = colors;
  const inner = contentWidth + 4; // 2-col padding each side
  const titleVw = title.length;
  const top =
    c.cyan('╭') +
    c.cyan(' ') +
    c.bold + title + c.reset +
    c.cyan('─'.repeat(Math.max(0, inner - titleVw - 1))) +
    c.cyan('╮');
  const bot = c.cyan('╰') + c.cyan('─'.repeat(inner)) + c.cyan('╯');
  const blank = c.cyan('│') + ' '.repeat(inner) + c.cyan('│');
  const out = [top, blank];
  for (const line of lines) {
    let display = line;
    let vw = visibleWidth(line);
    if (vw > contentWidth) {
      // Truncate to fit; ellipsis appended.
      display = `${line.slice(0, contentWidth - 1)}…`;
      vw = contentWidth;
    }
    const pad = ' '.repeat(Math.max(0, contentWidth - vw));
    out.push(`${c.cyan('│')}  ${display}${pad}  ${c.cyan('│')}`);
  }
  out.push(blank);
  out.push(bot);
  return out.join('\n');
}

export function renderStatusBar(opts: {
  ctxPct: number;
  dreamState: 'idle' | 'encoding' | 'running';
  agent: string;
  elapsedSec: number;
}): string {
  const { ctxPct, dreamState, agent, elapsedSec } = opts;
  const c = colors;
  const total = 10;
  const filled = Math.min(total, Math.round((ctxPct / 100) * total));
  const bar = '▓'.repeat(filled) + '░'.repeat(total - filled);
  const dreamColor = dreamState === 'running' ? c.warn : dreamState === 'encoding' ? c.cyan : c.muted;
  return [
    c.cyan('◈'),
    c.muted(`agent ${agent}`),
    c.muted(`│ ctx ${ctxPct}%`),
    c.muted(`[${bar}]`),
    `${c.muted('│')} ${dreamColor(`dream-${dreamState}`)}`,
    c.muted(`│ ${elapsedSec.toFixed(1)}s`),
  ].join(' ');
}

export function welcomeLine(agentName: string): string {
  return `${colors.cyan('Welcome to Meridian.')} ${colors.muted(`Ready when you are. (${agentName})`)}`;
}

// ─── Boot trace ───────────────────────────────────────────────────────────────
// dmesg-style "system coming online" lines. Renders between the wordmark
// and the boot panel so booting an agent feels like booting a system, not
// loading a script. Each line: `[ N.NNN ]  subsystem  ·  detail`.

export interface BootTraceLine {
  /** Time delta in milliseconds since boot start (0..9999). */
  tMs: number;
  subsystem: string;
  detail: string;
  /** Visual weight: 'ok' green dot, 'warn' amber, 'info' brand cyan. */
  level?: 'ok' | 'warn' | 'info';
}

export function renderBootTrace(lines: readonly BootTraceLine[]): string {
  const c = colors;
  const out: string[] = [];
  out.push('');
  for (const line of lines) {
    const seconds = (line.tMs / 1000).toFixed(3);
    const ts = c.muted(`[ ${seconds.padStart(5, ' ')} ]`);
    const dot =
      line.level === 'warn' ? c.warn('•') : line.level === 'info' ? c.cyan('•') : c.ok('•');
    const subsystem = c.steel(line.subsystem.padEnd(22, ' '));
    out.push(`  ${ts}  ${dot}  ${subsystem}${c.muted('· ')}${line.detail}`);
  }
  out.push('');
  return out.join('\n');
}

export interface BootTraceFacts {
  agentName: string;
  agentRole: string;
  cortexUrl: string;
  cortexStatus: 'ok' | 'degraded' | 'down';
  memoryCount?: number;
  synapseCount?: number;
  /**
   * Capability presence — labelled by what the runtime needs, never by which
   * vendor the user wired up. Meridian is provider-agnostic; the boot screen
   * never reveals the proprietary stack behind it.
   */
  isolation: { datastore: boolean; vectors: boolean; inference: boolean };
  channels: { telegram: boolean; voice: boolean; cli: boolean };
  lastDreamAt?: string;
  lastSession?: { turns: number; ago: string };
  bootDurationMs: number;
}

/** Build the trace lines for a given agent boot. Pure data → presentation. */
export function buildBootTrace(facts: BootTraceFacts): BootTraceLine[] {
  const c = colors;
  const yes = c.ok('✓');
  const no = c.muted('—');
  const lines: BootTraceLine[] = [];
  lines.push({
    tMs: 1,
    subsystem: 'cognition.identity',
    detail: `loaded · ${c.cyan(facts.agentName)} · ${c.muted(facts.agentRole)}`,
  });
  const memCount = facts.memoryCount?.toLocaleString() ?? '—';
  const synCount = facts.synapseCount?.toLocaleString() ?? '—';
  lines.push({
    tMs: 12,
    subsystem: 'cognition.cortex',
    level: facts.cortexStatus === 'ok' ? 'ok' : facts.cortexStatus === 'degraded' ? 'warn' : 'warn',
    detail: `online · ${memCount} nodes · ${synCount} synapses`,
  });
  lines.push({
    tMs: 18,
    subsystem: 'cognition.runtime',
    detail: `triad locked · datastore ${facts.isolation.datastore ? yes : no}  vectors ${facts.isolation.vectors ? yes : no}  inference ${facts.isolation.inference ? yes : no}`,
  });
  const chBits = [
    `telegram ${facts.channels.telegram ? yes : no}`,
    `voice ${facts.channels.voice ? yes : no}`,
    `cli ${facts.channels.cli ? yes : no}`,
  ].join('  ');
  lines.push({
    tMs: 24,
    subsystem: 'cognition.channels',
    detail: chBits,
  });
  if (facts.lastDreamAt) {
    lines.push({
      tMs: 30,
      subsystem: 'cognition.dream',
      detail: `weaver idle · last cycle ${c.muted(facts.lastDreamAt)}`,
    });
  }
  if (facts.lastSession) {
    lines.push({
      tMs: 36,
      subsystem: 'cognition.session',
      detail: `resumed · ${facts.lastSession.turns} turns · ${facts.lastSession.ago} ago`,
    });
  }
  const readyDisplay =
    facts.bootDurationMs >= 1000
      ? `${(facts.bootDurationMs / 1000).toFixed(2)}s`
      : `${facts.bootDurationMs}ms`;
  lines.push({
    tMs: facts.bootDurationMs,
    subsystem: 'system',
    level: 'info',
    detail: c.cyan('online') + c.muted(` · ready in ${readyDisplay}`),
  });
  return lines;
}

// ─── Slash command cheat sheet ─────────────────────────────────────────────────
// Rendered at boot so the REPL home screen shows every command grouped by
// category (OpenClaw / Hermes parity). Pure presentation — the source of
// truth lives in src/cli/commands/registry.ts.
export interface CheatSheetCommand {
  name: string;
  description: string;
  category: string;
  argsHint?: string;
}

const CATEGORY_ORDER = [
  'Session',
  'Info',
  'Configuration',
  'Tools',
  'CORTEX',
  'Exit',
] as const;

export function renderCommandCheatSheet(commands: readonly CheatSheetCommand[]): string {
  const c = colors;
  const grouped: Record<string, CheatSheetCommand[]> = {};
  for (const cmd of commands) {
    if (!grouped[cmd.category]) grouped[cmd.category] = [];
    grouped[cmd.category].push(cmd);
  }

  const lines: string[] = [];
  lines.push('');
  lines.push(`${c.bold}Slash commands${c.reset}${c.muted('  ·  type any of these inside the REPL')}`);
  for (const cat of CATEGORY_ORDER) {
    const items = grouped[cat];
    if (!items || items.length === 0) continue;
    lines.push('');
    lines.push(`  ${c.cyan(cat)}`);
    for (const cmd of items) {
      const slash = c.steel(`/${cmd.name}`);
      const args = cmd.argsHint ? c.muted(` ${cmd.argsHint}`) : '';
      const visibleHead = `/${cmd.name}${cmd.argsHint ? ` ${cmd.argsHint}` : ''}`;
      const padding = ' '.repeat(Math.max(2, 24 - visibleHead.length));
      lines.push(`    ${slash}${args}${padding}${c.muted(cmd.description)}`);
    }
  }
  lines.push('');
  lines.push(
    '  ' +
      c.muted('Anything that does not start with `/` is sent to the agent as a normal message.'),
  );
  return lines.join('\n');
}
