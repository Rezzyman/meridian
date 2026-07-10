/**
 * ingestFile(): vision-enabled image ingest vs the legacy stub, and the PDF
 * caps — page truncation (loud warning, never silent) and oversize rejection
 * (clear report line). The PDF fixture is generated in-test (minimal valid
 * PDF, one text line per page) so pdfjs parses real pages with no binary
 * fixtures checked in.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ingestFile, watchInbox } from '../../src/ingest/file-ingest.js';
import { mockCortex, silentLogger } from '../helpers/fixtures.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'meridian-ingest-'));
}

/** Minimal valid PDF: one Helvetica text line per page, correct xref. */
function makePdf(pageTexts: string[]): Buffer {
  const objects: string[] = [];
  const n = pageTexts.length;
  const kids = pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);
  objects.push('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  pageTexts.forEach((text, i) => {
    const pageNum = 4 + i * 2;
    const contentNum = pageNum + 1;
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`,
    );
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(
      `${contentNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  });
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

describe('image ingest', () => {
  it('uses the vision analysis when vision is enabled', async () => {
    const cortex = mockCortex();
    const dir = tmpDir();
    const img = join(dir, 'roof.png');
    writeFileSync(img, Buffer.alloc(32, 1));
    const analyzed: string[] = [];
    const r = await ingestFile(cortex, img, {
      logger: silentLogger,
      vision: {
        enabled: true,
        analyze: async (p) => {
          analyzed.push(p);
          return { description: 'Hail bruising across the south slope shingles.', model: 'anthropic/mock' };
        },
      },
    });
    assert.equal(r.type, 'image');
    assert.equal(r.chunks, 1);
    assert.deepEqual(analyzed, [img]);
    assert.equal(cortex.encodeCalls.length, 1);
    const content = cortex.encodeCalls[0].content;
    assert.ok(content.includes('Hail bruising across the south slope shingles.'));
    assert.ok(content.includes('Vision analysis (anthropic/mock)'));
  });

  it('falls back to the path stub when vision is disabled', async () => {
    const cortex = mockCortex();
    const dir = tmpDir();
    const img = join(dir, 'roof.png');
    writeFileSync(img, Buffer.alloc(32, 1));
    let called = false;
    const r = await ingestFile(cortex, img, {
      logger: silentLogger,
      vision: {
        enabled: false,
        analyze: async () => {
          called = true;
          return { description: 'nope', model: 'x' };
        },
      },
    });
    assert.equal(r.chunks, 1);
    assert.equal(called, false, 'analyze must not run when disabled');
    const content = cortex.encodeCalls[0].content;
    assert.ok(content.includes(`File path: ${img}`));
    assert.ok(!content.includes('Vision analysis'));
  });

  it('falls back to the stub when analysis fails (no lost ingest)', async () => {
    const cortex = mockCortex();
    const dir = tmpDir();
    const img = join(dir, 'roof.jpg');
    writeFileSync(img, Buffer.alloc(32, 1));
    const r = await ingestFile(cortex, img, {
      logger: silentLogger,
      vision: {
        enabled: true,
        analyze: async () => {
          throw new Error('provider down');
        },
      },
    });
    assert.equal(r.chunks, 1);
    assert.ok(cortex.encodeCalls[0].content.includes(`File path: ${img}`));
  });
});

describe('pdf caps', () => {
  it('rejects a PDF over maxBytesMb with a clear report line', async () => {
    const cortex = mockCortex();
    const dir = tmpDir();
    const big = join(dir, 'survey.pdf');
    writeFileSync(big, Buffer.alloc(2 * 1024 * 1024, 0x20)); // 2 MB of padding
    await assert.rejects(
      ingestFile(cortex, big, { logger: silentLogger, pdf: { maxBytesMb: 1 } }),
      /PDF rejected: 2\.0 MB exceeds the 1 MB limit \(pdf\.maxBytesMb\)/,
    );
    assert.equal(cortex.encodeCalls.length, 0, 'nothing encoded from a rejected PDF');
  });

  it('truncates at maxPages with a loud warning, keeping the kept pages', async () => {
    const cortex = mockCortex();
    const dir = tmpDir();
    const pdf = join(dir, 'report.pdf');
    writeFileSync(pdf, makePdf(['Alpha page one', 'Bravo page two', 'Charlie page three']));
    const r = await ingestFile(cortex, pdf, { logger: silentLogger, pdf: { maxPages: 2 } });
    assert.equal(r.type, 'pdf');
    assert.equal(r.warnings?.length, 1);
    assert.match(r.warnings![0], /ingested 2 of 3 pages/);
    assert.match(r.warnings![0], /pdf\.maxPages=2/);
    assert.match(r.warnings![0], /pages 3-3 were skipped/);
    const encoded = cortex.encodeCalls.map((c) => c.content).join('\n');
    assert.ok(encoded.includes('Alpha page one'));
    assert.ok(encoded.includes('Bravo page two'));
    assert.ok(!encoded.includes('Charlie page three'), 'page 3 must be skipped');
  });

  it('emits no warning when the PDF fits within maxPages', async () => {
    const cortex = mockCortex();
    const dir = tmpDir();
    const pdf = join(dir, 'short.pdf');
    writeFileSync(pdf, makePdf(['Only page here']));
    const r = await ingestFile(cortex, pdf, { logger: silentLogger, pdf: { maxPages: 50 } });
    assert.equal(r.warnings, undefined);
    assert.ok(cortex.encodeCalls[0].content.includes('Only page here'));
  });
});

describe('inbox watcher failure semantics', () => {
  it('marks a document .failed (not .processed) when every chunk fails to encode', async () => {
    const dir = tmpDir();
    const dead = mockCortex();
    dead.encode = async () => {
      throw new Error('no backend');
    };
    const stop = watchInbox(dead, dir, { logger: silentLogger, debounceMs: 50 });
    writeFileSync(join(dir, 'doc.md'), '# survey\n\nreal content that must not vanish');
    // Watcher debounce (50ms) + async ingest; poll for the rename.
    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      if (readdirSync(dir).some((f) => f.endsWith('.failed') || f.endsWith('.processed'))) break;
    }
    stop();
    const files = readdirSync(dir);
    assert.ok(files.includes('doc.md.failed'), `expected doc.md.failed, got: ${files.join(',')}`);
    assert.ok(!files.includes('doc.md.processed'), 'a lost document must never look processed');
  });

  it('marks a document .processed when chunks store, and records the count', async () => {
    const dir = tmpDir();
    const cortex = mockCortex();
    const stop = watchInbox(cortex, dir, { logger: silentLogger, debounceMs: 50 });
    writeFileSync(join(dir, 'ok.md'), '# note\n\ncontent that stores fine');
    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      if (readdirSync(dir).some((f) => f.endsWith('.processed'))) break;
    }
    stop();
    assert.ok(readdirSync(dir).includes('ok.md.processed'));
    assert.ok(cortex.encodeCalls.length > 0);
  });
});
