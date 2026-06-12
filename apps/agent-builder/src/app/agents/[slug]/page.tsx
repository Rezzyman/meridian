import { Suspense } from 'react';
import { AgentRoom } from '@/components/AgentRoom';

export const dynamic = 'force-dynamic';

export default async function AgentPage(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  return (
    <Suspense fallback={null}>
      <AgentRoom slug={slug} />
    </Suspense>
  );
}
