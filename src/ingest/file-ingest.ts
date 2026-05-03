/**
 * File ingest — turn the agent multimodal.
 *
 * `meridian ingest <path>` and an optional auto-watch on the agent's
 * `MEMORY/inbox/` directory. Each file lands in CORTEX as one or more
 * memories with full source attribution.
 *
 * v0.7 supported types:
 *   - text/markdown — direct, chunked at paragraph boundaries
 *   - PDF           — pdfjs-dist text extraction, page-aware chunks
 *   - image         — encoded as a "saw an image at <path>" stub memory
 *                     (multimodal Voyage embeddings come in v0.2)
 *   - audio         — same stub treatment; Whisper transcription is v0.2
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
}

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
    if ((buf + '\n\n' + p).length > MAX_CHUNK_CHARS && buf.length > MIN_CHUNK_CHARS) {
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

async function extractPdf(path: string): Promise<string> {
  // pdfjs-dist is ESM-only; use the legacy build for Node compatibility.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(path));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((it) => ('str' in it ? it.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) out.push(`[page ${i}]\n${text}`);
  }
  return out.join('\n\n');
}

export async function ingestFile(
  cortex: MemoryProvider,
  filePath: string,
  opts: { logger?: Logger; sourceTag?: string } = {},
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
    let text = '';
    try {
      text = await extractPdf(abs);
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
    };
  }

  if (type === 'image' || type === 'audio') {
    // Stub memory — file path + metadata only. Real multimodal embedding
    // (Voyage multimodal for images, Whisper for audio) is v0.2.
    const stub = `[${type}] ${basename(abs)}\nFile path: ${abs}\nSize: ${st.size} bytes\nIngested: ${new Date().toISOString()}`;
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
  opts: { logger?: Logger; debounceMs?: number } = {},
): () => void {
  if (!existsSync(dir)) return () => {};
  const debounce = opts.debounceMs ?? 1500;
  const pending = new Map<string, NodeJS.Timeout>();
  const watcher = watch(dir, { persistent: false }, (_event, filename) => {
    if (!filename) return;
    if (filename.endsWith('.processed') || filename.startsWith('.')) return;
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
        });
        opts.logger?.info({
          msg: 'inbox ingested',
          file: filename,
          type: result.type,
          chunks: result.chunks,
        });
        // Rename to .processed so re-runs skip it.
        const { renameSync } = await import('node:fs');
        renameSync(path, `${path}.processed`);
      } catch (err) {
        opts.logger?.warn({ msg: 'inbox ingest failed', err, path });
      }
    }, debounce);
    pending.set(filename, t);
  });
  return () => watcher.close();
}
