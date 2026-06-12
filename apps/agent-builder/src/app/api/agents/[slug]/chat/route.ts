/**
 * Chat proxy: browser → this route → the agent's local gateway. Server-side
 * piping means no CORS, no ports, and no tokens in the browser; the gateway
 * stays bound to 127.0.0.1. Streams the gateway's SSE (/chat/stream — the
 * same contract skeleton/web/chat.html consumes) straight through.
 */

import { NextResponse } from 'next/server';
import { gatewayStatus } from '@/lib/gateway';

export const dynamic = 'force-dynamic';
// A full agent turn (recall → model → verify → encode) can be slow on local models.
export const maxDuration = 300;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await ctx.params;
  let message: string;
  try {
    const body = (await req.json()) as { message?: string };
    message = (body.message ?? '').trim();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (!message) return NextResponse.json({ error: 'message required' }, { status: 400 });

  const status = await gatewayStatus(slug);
  if (status.state !== 'running' || !status.port) {
    return NextResponse.json(
      { error: 'gateway not running', state: status.state },
      { status: 409 },
    );
  }

  try {
    const upstream = await fetch(`http://127.0.0.1:${status.port}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: message }),
      signal: req.signal,
    });
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      return NextResponse.json(
        { error: `gateway returned ${upstream.status}: ${text.slice(0, 200)}` },
        { status: 502 },
      );
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `could not reach gateway: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}
