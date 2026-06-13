/**
 * Generates assets/meridian-logo.svg — the README hero, a faithful color
 * rendering of the CLI boot banner (src/cli/banner.ts): the █-block "MERIDIAN"
 * wordmark in the brand blue 3-stop gradient, with a white radiating starburst
 * through the letters and the "THE AGENT OS · BY ATERNA AI" byline.
 *
 * The wordmark is drawn as monospace <text> so the box-drawing glyphs render in
 * their true shapes (a full-cell fill would close the letter counters). Box +
 * block-element glyphs (U+2500–U+259F) are present in essentially every
 * monospace font, so this renders faithfully across viewers.
 *
 * Run: node assets/gen-logo.cjs   (writes assets/meridian-logo.svg)
 */
const fs = require('node:fs');
const path = require('node:path');

// Exact wordmark grid from src/cli/banner.ts (ANSI-Shadow "MERIDIAN").
const WORDMARK = [
  '███╗   ███╗  ███████╗  ██████╗   ██╗  ██████╗   ██╗   █████╗   ███╗   ██╗',
  '████╗ ████║  ██╔════╝  ██╔══██╗  ██║  ██╔══██╗  ██║  ██╔══██╗  ████╗  ██║',
  '██╔████╔██║  █████╗    ██████╔╝  ██║  ██║  ██║  ██║  ███████║  ██╔██╗ ██║',
  '██║╚██╔╝██║  █████╗    ██████╔╝  ██║  ██║  ██║  ██║  ███████║  ██╔██╗ ██║',
  '██║ ╚═╝ ██║  ██╔══╝    ██╔══██╗  ██║  ██║  ██║  ██║  ██╔══██║  ██║╚██╗██║',
  '██║     ██║  ███████╗  ██║  ██║  ██║  ██████╔╝  ██║  ██║  ██║  ██║ ╚████║',
  '██║     ██║  ███████╗  ██║  ██║  ██║  ██████╔╝  ██║  ██║  ██║  ██║ ╚████║',
  '╚═╝     ╚═╝  ╚══════╝  ╚═╝  ╚═╝  ╚═╝  ╚═════╝   ╚═╝  ╚═╝  ╚═╝  ╚═╝  ╚═══╝',
];

const W = 1200;
const H = 500;
const FS = 22; // monospace font-size
const ADV = FS * 0.6; // monospace advance width per glyph
const LINEH = 23;
const cols = Math.max(...WORDMARK.map((l) => Array.from(l).length));
const wmW = cols * ADV;
const left = Math.round((W - wmW) / 2);
const top = 192; // baseline of first row
const eyeX = Math.round(left + wmW / 2);
const eyeY = Math.round(top + 3.5 * LINEH - FS / 2);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const tspans = WORDMARK.map(
  (line, i) => `<tspan x="${left}" dy="${i === 0 ? 0 : LINEH}">${esc(line)}</tspan>`,
).join('');

// Radiating starburst: vertical spine + diagonal fans, mirrored top/bottom.
const RAYS = [
  { t: 0, len: 165 }, // dominant vertical spine
  { t: 21, len: 140 },
  { t: 43, len: 120 },
  { t: 64, len: 100 },
  { t: 82, len: 168 }, // long shallow "kick" rays out to the sides
];
const rad = (d) => (d * Math.PI) / 180;
const lines = [];
for (const { t, len } of RAYS) {
  const sin = Math.sin(rad(t));
  const cos = Math.cos(rad(t));
  const op = (0.92 - t / 220).toFixed(2);
  for (const sx of t === 0 ? [0] : [-1, 1]) {
    for (const sy of [-1, 1]) {
      const x2 = (eyeX + sx * len * sin).toFixed(1);
      const y2 = (eyeY + sy * len * cos).toFixed(1);
      lines.push(
        `<line x1="${eyeX}" y1="${eyeY}" x2="${x2}" y2="${y2}" stroke="url(#ray)" stroke-width="2.2" stroke-dasharray="3 6" stroke-linecap="round" opacity="${op}"/>`,
      );
    }
  }
}

const gradTop = top - FS;
const gradBot = top + 7 * LINEH + 4;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="MERIDIAN — the agent OS by ATERNA AI">
  <defs>
    <linearGradient id="wm" x1="0" y1="${gradTop}" x2="0" y2="${gradBot}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#5AccFF"/>
      <stop offset="0.5" stop-color="#1FAEFF"/>
      <stop offset="1" stop-color="#0088E0"/>
    </linearGradient>
    <radialGradient id="ray" cx="${eyeX}" cy="${eyeY}" r="185" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="0.65" stop-color="#CFE0FF"/>
      <stop offset="1" stop-color="#9FB0CC" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vign" cx="${eyeX}" cy="${eyeY}" r="${eyeX - 20}" gradientUnits="userSpaceOnUse">
      <stop offset="0.62" stop-color="#070A12" stop-opacity="0"/>
      <stop offset="1" stop-color="#070A12"/>
    </radialGradient>
  </defs>

  <rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="28" fill="#070A12" stroke="#16202E" stroke-width="1.5"/>

  <g>${lines.join('')}</g>
  <rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="28" fill="url(#vign)"/>

  <text xml:space="preserve" y="${top}" font-family="'Menlo','DejaVu Sans Mono','Liberation Mono','Consolas',monospace" font-size="${FS}" fill="url(#wm)">${tspans}</text>

  <text x="${eyeX}" y="${top + 7 * LINEH + 48}" text-anchor="middle" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="22" font-weight="700" letter-spacing="6" fill="#1FAEFF">THE AGENT OS<tspan fill="#6E8294" font-weight="500"> · BY ATERNA AI</tspan></text>
</svg>
`;

fs.writeFileSync(path.join(__dirname, 'meridian-logo.svg'), svg);
console.log(`wrote meridian-logo.svg — ${lines.length} rays, ${svg.length} bytes`);
