import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type AudioTranscriber = (audio: Buffer, mimeType: string) => Promise<string>;
export type ImageDescriber = (image: Buffer, prompt: string) => Promise<string>;

export interface DeviceLookParts {
  frame: Buffer;
  prompt: string;
}

/** Local, private speech recognition for the Mac Mini gateway. Audio is deleted after the turn. */
export function localWhisperTranscriber(opts: {
  command?: string;
  model?: string;
  language?: string;
} = {}): AudioTranscriber {
  const command = opts.command ?? 'whisper';
  const model = opts.model ?? 'base.en';
  const language = opts.language ?? 'en';
  return async (audio, mimeType) => {
    if (audio.length < 44) throw new Error('audio payload is empty');
    const extension = mimeType.includes('wav') ? 'wav' : 'audio';
    const directory = await mkdtemp(join(tmpdir(), 'meridian-r1-audio-'));
    const input = join(directory, `turn.${extension}`);
    const output = join(directory, 'turn.json');
    try {
      await writeFile(input, audio, { mode: 0o600 });
      await execFileAsync(command, [
        input,
        '--model', model,
        '--language', language,
        '--task', 'transcribe',
        '--output_dir', directory,
        '--output_format', 'json',
        '--verbose', 'False',
        '--fp16', 'False',
      ], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
      const decoded = JSON.parse(await readFile(output, 'utf8')) as { text?: unknown };
      const text = typeof decoded.text === 'string' ? decoded.text.trim() : '';
      if (!text) throw new Error('speech recognizer returned no text');
      return text;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

/** Local Ollama vision adapter. Camera frames stay on the guardian's Mac Mini. */
export function localOllamaImageDescriber(opts: {
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
} = {}): ImageDescriber {
  const baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = opts.model ?? 'gemma4:e4b';
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async (image, prompt) => {
    if (image.length < 16) throw new Error('camera frame is empty');
    const response = await fetchImpl(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{
          role: 'user',
          content: prompt || 'Describe what is visible. Be concise and child-friendly.',
          images: [image.toString('base64')],
        }],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`vision model returned ${response.status}`);
    const body = (await response.json()) as { message?: { content?: unknown } };
    const description =
      typeof body.message?.content === 'string' ? body.message.content.trim() : '';
    if (!description) throw new Error('vision model returned no description');
    return description;
  };
}

/** Minimal bounded parser for the Android client's fixed `meta` + `frame` multipart contract. */
export function parseDeviceLookMultipart(body: Buffer, boundary: string): DeviceLookParts {
  if (!boundary || body.length > 8 * 1024 * 1024) throw new Error('invalid multipart body');
  const marker = Buffer.from(`--${boundary}`);
  const headerEnd = Buffer.from('\r\n\r\n');
  const parts = new Map<string, Buffer>();
  let cursor = 0;
  while (true) {
    const start = body.indexOf(marker, cursor);
    if (start < 0) break;
    const headersStart = start + marker.length + 2;
    const headersEnd = body.indexOf(headerEnd, headersStart);
    if (headersEnd < 0) break;
    const headers = body.subarray(headersStart, headersEnd).toString('utf8');
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    const contentStart = headersEnd + headerEnd.length;
    const next = body.indexOf(marker, contentStart);
    if (next < 0) break;
    const contentEnd = Math.max(contentStart, next - 2);
    if (name) parts.set(name, body.subarray(contentStart, contentEnd));
    cursor = next;
  }
  const frame = parts.get('frame');
  if (!frame || frame.length < 16) throw new Error('multipart frame missing');
  let prompt = 'Describe what is visible. Be concise and child-friendly.';
  const meta = parts.get('meta');
  if (meta) {
    const decoded = JSON.parse(meta.toString('utf8')) as { prompt?: unknown };
    if (typeof decoded.prompt === 'string' && decoded.prompt.trim()) prompt = decoded.prompt.trim();
  }
  return { frame, prompt };
}
