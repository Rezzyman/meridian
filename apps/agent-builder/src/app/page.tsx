import Link from 'next/link';
import { listAgentSummaries } from '@/lib/agents';
import { getPersona } from '@/lib/personas';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const agents = await listAgentSummaries();

  return (
    <main>
      <section className="hero">
        <h1>Your own AI agent, built in a few clicks.</h1>
        <p>
          Pick what it should do, answer a few friendly questions, and meet an agent that
          remembers you — running privately on this computer, with memory safety on by default.
          No code. No terminal. No accounts.
        </p>
        <Link href="/new" className="btn primary lg">
          Build my agent →
        </Link>
      </section>

      <section className="how">
        <div className="card">
          <h3>
            <span className="n">1</span> Choose its job
          </h3>
          <p>Chief of staff, receptionist, sales qualifier, concierge, or personal assistant.</p>
        </div>
        <div className="card">
          <h3>
            <span className="n">2</span> Make it yours
          </h3>
          <p>Name it, tell it who it works for, how to sound, and what to remember.</p>
        </div>
        <div className="card">
          <h3>
            <span className="n">3</span> Meet it
          </h3>
          <p>Chat instantly. It remembers you next time — even after a restart.</p>
        </div>
      </section>

      <h2 className="section">Your agents</h2>
      {agents.length === 0 ? (
        <div className="card empty-state">
          No agents yet — your first one is two minutes away.
        </div>
      ) : (
        <div className="agent-grid">
          {agents.map((a) => {
            const persona = a.template ? getPersona(a.template) : undefined;
            return (
              <Link key={a.slug} href={`/agents/${a.slug}`} className="card agent-tile">
                <span className="avatar">{a.name.charAt(0).toUpperCase()}</span>
                <span className="meta">
                  <h3>{a.name}</h3>
                  <p>{persona?.title ?? a.role.replace(/_/g, ' ')}</p>
                </span>
                <span className={`status-dot ${a.gateway.state}`} title={a.gateway.state} />
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
