import { NextResponse } from 'next/server';
import { listAgentSummaries } from '@/lib/agents';
import { buildAgent } from '@/lib/build';
import type { WizardSubmission } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ agents: await listAgentSummaries() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  let submission: WizardSubmission;
  try {
    submission = (await req.json()) as WizardSubmission;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (!submission?.personaKey || !submission?.operatorName?.trim()) {
    return NextResponse.json(
      { error: 'personaKey and operatorName are required' },
      { status: 400 },
    );
  }
  try {
    const result = await buildAgent(submission);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
