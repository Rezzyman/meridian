import { NextResponse } from 'next/server';
import { summarizeAgent } from '@/lib/agents';
import { startGateway, stopGateway } from '@/lib/gateway';

export const dynamic = 'force-dynamic';
// Gateway cold boot (provider + tool surface + cortex probe) can take a while.
export const maxDuration = 60;

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await ctx.params;
  if (!(await summarizeAgent(slug))) {
    return NextResponse.json({ error: `agent "${slug}" not found` }, { status: 404 });
  }
  try {
    const result = await startGateway(slug);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await ctx.params;
  try {
    const status = await stopGateway(slug);
    return NextResponse.json({ status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
