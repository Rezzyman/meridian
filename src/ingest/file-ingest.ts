/**
 * File ingest — turn the agent multimodal.
 *
 * `meridian ingest <path>` and an optional auto-watch on the agent's
 * `MEMORY/inbox/` directory. Each file lands in CORTEX as one or more
 * memories with full source attribution.
 *
 * Supported types:
 *   - text/markdown — direct, chunked at paragraph boundaries
 *   - PDF           — pdfjs-dist text extraction, page-aware chunks, capped
 *                     at pdf.maxPages (loud truncation warning) and rejected
 *                     over pdf.maxBytesMb
 *   - image         — real vision analysis when vision is enabled (pass an
 *                     `analyze` hook); "saw an image at <path>" stub otherwise
 *   - audio         — stub treatment; Whisper transcription is v0.2
 *
 * Returns a summary object so callers (CLI + watcher) can report what
 * landed where.
 */

import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { extname, basename, resolve } from 'node:path';
import type { Logger } from 'pino';
import type { MemoryProvider } from '../memory/provider.js';

export interface IngestResult {
  path: string;
  type: 'text' | 'markdown' | 'pdf' | 'image' | 'audio' | 'unknown';
  chunks: number;
  memoryIds: number[];
  bytes: number;
  durationMs: number;
  /** Non-fatal notes the operator should see (e.g. PDF page truncation). */
  warnings?: string[];
}

export interface IngestOptions {
  logger?: Logger;
  sourceTag?: string;
  /** Vision hook — when enabled, images are analyzed for real instead of
   *  landing as path stubs. `analyze` errors fall back to the stub. */
  vision?: {
    enabled: boolean;
    analyze?: (path: string) => Promise<{ description: string; model: string }>;
  };
  /** PDF ingestion caps (OpenClaw parity: 50 pages / 32 MB). */
  pdf?: {
    maxPages?: number;
    maxBytesMb?: number;
  };
}

export const PDF_MAX_PAGES_DEFAULT = 50;
export const PDF_MAX_BYTES_MB_DEFAULT = 32;

const TEXT_EXT = new Set(['.txt', '.log', '.json', '.csv', '.tsv', '.yml', '.yaml']);
const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx']);
const PDF_EXT = new Set(['.pdf']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac']);

const MAX_CHUNK_CHARS = 4000;
const MIN_CHUNK_CHARS = 200;

function detectType(path: string): IngestResult['type'] {
  const ext = extname(path).toLowerCase();
  if (TEXT_EXT.has(ext)) return 'text';
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (PDF_EXT.has(ext)) return 'pdf';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'unknown';
}

function chunk(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= MAX_CHUNK_CHARS) return [trimmed];
  // Split on paragraphs first; fall back to character cut at MAX_CHUNK_CHARS
  // boundary if any single paragraph is too long.
  const paragraphs = trimmed.split(/\n{2,}/);
  const out: string[] = [];
  let buf = '';
  for (const p of paragraphs) {
    if ((`${buf}\n\n${p}`).length > MAX_CHUNK_CHARS && buf.length > MIN_CHUNK_CHARS) {
      out.push(buf.trim());
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
    while (buf.length > MAX_CHUNK_CHARS) {
      out.push(buf.slice(0, MAX_CHUNK_CHARS).trim());
      buf = buf.slice(MAX_CHUNK_CHARS).trim();
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

async function extractPdf(
  path: string,
  maxPages: number,
): Promise<{ text: string; totalPages: number; extractedPages: number }> {
  // pdfjs-dist is ESM-only; use the legacy build for Node compatibility.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(path));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const out: string[] = [];
  const extractedPages = Math.min(doc.numPages, maxPages);
  for (let i = 1; i <= extractedPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((it) => ('str' in it ? it.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) out.push(`[page ${i}]\n${text}`);
  }
  return { text: out.join('\n\n'), totalPages: doc.numPages, extractedPages };
}

export async function ingestFile(
  cortex: MemoryProvider,
  filePath: string,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const started = Date.now();
  const abs = resolve(filePath);
  if (!existsSync(abs)) {
    throw new Error(`file not found: ${abs}`);
  }
  const st = statSync(abs);
  const type = detectType(abs);
  const sourceTag = opts.sourceTag ?? `meridian:ingest:${basename(abs)}`;
  const memoryIds: number[] = [];

  if (type === 'text' || type === 'markdown') {
    const body = readFileSync(abs, 'utf8');
    const chunks = chunk(body);
    for (const c of chunks) {
      try {
        const r = await cortex.encode(c, {
          source: sourceTag,
          priority: 2,
          sensitivity: 'internal',
        });
        memoryIds.push(r.memoryId);
      } catch (err) {
        opts.logger?.warn({ msg: 'ingest encode failed', err, path: abs });
      }
    }
    return {
      path: abs,
      type,
      chunks: chunks.length,
      memoryIds,
      bytes: st.size,
      durationMs: Date.now() - started,
    };
  }

  if (type === 'pdf') {
    // Size cap FIRST — a 300 MB scan would otherwise be pulled whole into
    // memory by pdfjs. Rejection is a thrown error so the ingest report
    // (CLI + inbox watcher) shows a clear failure line, never a silent skip.
    const maxBytesMb = opts.pdf?.maxBytesMb ?? PDF_MAX_BYTES_MB_DEFAULT;
    const maxBytes = maxBytesMb * 1024 * 1024;
    if (st.size > maxBytes) {
      throw new Error(
        `PDF rejected: ${(st.size / (1024 * 1024)).toFixed(1)} MB exceeds the ${maxBytesMb} MB limit (pdf.maxBytesMb)`,
      );
    }
    const maxPages = opts.pdf?.maxPages ?? PDF_MAX_PAGES_DEFAULT;
    const warnings: string[] = [];
    let text = '';
    try {
      const extracted = await extractPdf(abs, maxPages);
      text = extracted.text;
      if (extracted.totalPages > extracted.extractedPages) {
        const w = `PDF truncated: ingested ${extracted.extractedPages} of ${extracted.totalPages} pages (pdf.maxPages=${maxPages}); pages ${extracted.extractedPages + 1}-${extracted.totalPages} were skipped`;
        warnings.push(w);
        opts.logger?.warn({
          msg: 'pdf page-cap truncation',
          path: abs,
          totalPages: extracted.totalPages,
          extractedPages: extracted.extractedPages,
          maxPages,
        });
      }
    } catch (err) {
      opts.logger?.warn({ msg: 'pdf extract failed', err, path: abs });
    }
    const chunks = chunk(text);
    for (const c of chunks) {
      try {
        const r = await cortex.encode(c, {
          source: sourceTag,
          priority: 2,
          sensitivity: 'internal',
        });
        memoryIds.push(r.memoryId);
      } catch (err) {
        opts.logger?.warn({ msg: 'ingest encode failed', err, path: abs });
      }
    }
    return {
      path: abs,
      type,
      chunks: chunks.length,
      memoryIds,
      bytes: st.size,
      durationMs: Date.now() - started,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  if (type === 'image' || type === 'audio') {
    // Images: real vision analysis when the hook is enabled; the description
    // becomes the memory (searchable by content, not just filename). Audio —
    // and any vision failure/disabled path — falls back to the metadata stub.
    let content: string | undefined;
    if (type === 'image' && opts.vision?.enabled && opts.vision.analyze) {
      try {
        const a = await opts.vision.analyze(abs);
        content =
          `[image] ${basename(abs)}\nFile path: ${abs}\n` +
          `Vision analysis (${a.model}):\n${a.description}`;
      } catch (err) {
        opts.logger?.warn({
          msg: 'vision analysis failed during ingest; falling back to stub',
          err,
          path: abs,
        });
      }
    }
    const stub =
      content ??
      `[${type}] ${basename(abs)}\nFile path: ${abs}\nSize: ${st.size} bytes\nIngested: ${new Date().toISOString()}`;
    try {
      const r = await cortex.encode(stub, {
        source: sourceTag,
        priority: 2,
        sensitivity: 'internal',
      });
      memoryIds.push(r.memoryId);
    } catch (err) {
      opts.logger?.warn({ msg: 'ingest stub failed', err, path: abs });
    }
    return {
      path: abs,
      type,
      chunks: 1,
      memoryIds,
      bytes: st.size,
      durationMs: Date.now() - started,
    };
  }

  return {
    path: abs,
    type: 'unknown',
    chunks: 0,
    memoryIds: [],
    bytes: st.size,
    durationMs: Date.now() - started,
  };
}

/**
 * Watch a directory for new files. Each new file is ingested and (after
 * success) renamed to `<filename>.processed` so re-running the gateway
 * does not re-ingest. Returns a stop function.
 */
export function watchInbox(
  cortex: MemoryProvider,
  dir: string,
  opts: { logger?: Logger; debounceMs?: number; vision?: IngestOptions['vision']; pdf?: IngestOptions['pdf'] } = {},
): () => void {
  if (!existsSync(dir)) return () => {};
  const debounce = opts.debounceMs ?? 1500;
  const pending = new Map<string, NodeJS.Timeout>();
  const watcher = watch(dir, { persistent: false }, (_event, filename) => {
    if (!filename) return;
    if (filename.endsWith('.processed') || filename.endsWith('.failed') || filename.startsWith('.'))
      return;
    const existing = pending.get(filename);
    if (existing) clearTimeout(existing);
    const t = setTimeout(async () => {
      pending.delete(filename);
      const path = resolve(dir, filename);
      if (!existsSync(path)) return;
      try {
        const result = await ingestFile(cortex, path, {
          logger: opts.logger,
          sourceTag: `meridian:inbox:${filename}`,
          vision: opts.vision,
          pdf: opts.pdf,
        });
        const { renameSync } = await import('node:fs');
        if (result.chunks > 0 && result.memoryIds.length === 0) {
          // Every chunk failed to encode — that is a LOST document, not a
          // processed one. Park it as .failed so the operator can see it and
          // a fixed backend can re-ingest by stripping the suffix.
          opts.logger?.warn({
            msg: 'inbox ingest stored nothing — marked .failed',
            file: filename,
            type: result.type,
            chunks: result.chunks,
          });
          renameSync(path, `${path}.failed`);
          return;
        }
        opts.logger?.info({
          msg: 'inbox ingested',
          file: filename,
          type: result.type,
          chunks: result.chunks,
          stored: result.memoryIds.length,
          ...(result.warnings?.length ? { warnings: result.warnings } : {}),
        });
        // Rename to .processed so re-runs skip it.
        renameSync(path, `${path}.processed`);
      } catch (err) {
        opts.logger?.warn({ msg: 'inbox ingest failed', err, path });
      }
    }, debounce);
    pending.set(filename, t);
  });
  return () => watcher.close();
}
