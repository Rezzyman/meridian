import { NextResponse } from 'next/server';
import { summarizeAgent } from '@/lib/agents';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await ctx.params;
  const summary = await summarizeAgent(slug);
  if (!summary) return NextResponse.json({ error: `agent "${slug}" not found` }, { status: 404 });
  return NextResponse.json(summary);
}
