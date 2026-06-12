'use client';

/**
 * The agent room: streaming chat with one agent plus its status rail.
 * The chat streaming logic is a TypeScript port of skeleton/web/chat.html —
 * same SSE contract (delta / reset / tool / done / error), pointed at the
 * builder's server-side proxy instead of the gateway directly.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getPersona } from '@/lib/personas';
import type { AgentSummary, GatewayState } from '@/lib/types';

interface Msg {
  role: 'user' | 'agent' | 'sys' | 'err';
  text: string;
}

export function AgentRoom({ slug }: { slug: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const isWelcome = search.get('welcome') === '1';

  const [agent, setAgent] = useState<AgentSummary | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [gatewayBusy, setGatewayBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const kickoffDone = useRef(false);

  const persona = agent?.template ? getPersona(agent.template) : undefined;
  const gwState: GatewayState = agent?.gateway.state ?? 'stopped';

  const refresh = useCallback(async (): Promise<AgentSummary | null> => {
    const res = await fetch(`/api/agents/${slug}`);
    if (res.status === 404) {
      setNotFound(true);
      return null;
    }
    const json = (await res.json()) as AgentSummary;
    setAgent(json);
    return json;
  }, [slug]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 8000);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const push = useCallback((msg: Msg) => setMessages((m) => [...m, msg]), []);

  /** Stream one turn through the proxy; mutates the last agent bubble live. */
  const send = useCallback(
    async (text: string, opts?: { hidden?: boolean }) => {
      if (!opts?.hidden) push({ role: 'user', text });
      setBusy(true);
      try {
        const res = await fetch(`/api/agents/${slug}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: text }),
        });
        if (!res.ok || !res.body) {
          const json = await res.json().catch(() => ({ error: `chat failed (${res.status})` }));
          push({ role: 'err', text: json.error || 'chat failed' });
          return;
        }

        let agentIdx = -1;
        let buffer = '';
        const render = () => {
          setMessages((m) => {
            const next = [...m];
            if (agentIdx === -1) {
              next.push({ role: 'agent', text: buffer || '…' });
              agentIdx = next.length - 1;
            } else {
              next[agentIdx] = { role: 'agent', text: buffer || '…' };
            }
            return next;
          });
        };

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const frames = pending.split('\n\n');
          pending = frames.pop() ?? '';
          for (const frame of frames) {
            let event = 'message';
            let data = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7).trim();
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            let body: { text?: string; reply?: string; name?: string; error?: string } = {};
            try {
              body = data ? JSON.parse(data) : {};
            } catch {
              /* keep {} */
            }
            if (event === 'delta') {
              buffer += body.text || '';
              render();
            } else if (event === 'reset') {
              buffer = '';
              render();
            } else if (event === 'tool') {
              push({ role: 'sys', text: `⚙ using ${body.name || 'a tool'}` });
            } else if (event === 'done') {
              buffer = body.reply || buffer;
              render();
            } else if (event === 'error') {
              push({ role: 'err', text: body.error || 'stream error' });
            }
          }
        }
      } catch (err) {
        push({ role: 'err', text: `Could not reach ${agent?.name ?? 'the agent'}: ${(err as Error).message}` });
      } finally {
        setBusy(false);
      }
    },
    [slug, push, agent?.name],
  );

  const startGateway = useCallback(async (): Promise<boolean> => {
    setGatewayBusy(true);
    push({ role: 'sys', text: 'Waking your agent…' });
    try {
      const res = await fetch(`/api/agents/${slug}/gateway`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        push({ role: 'err', text: json.error || 'could not start the agent' });
        return false;
      }
      await refresh();
      return json.status?.state === 'running';
    } finally {
      setGatewayBusy(false);
    }
  }, [slug, push, refresh]);

  const stopGateway = useCallback(async () => {
    setGatewayBusy(true);
    try {
      await fetch(`/api/agents/${slug}/gateway`, { method: 'DELETE' });
      await refresh();
      push({ role: 'sys', text: 'Agent paused. Start it again any time — it keeps its memory.' });
    } finally {
      setGatewayBusy(false);
    }
  }, [slug, refresh, push]);

  // ── First-meeting magic: greet by name, then plant the memory hint. ──
  useEffect(() => {
    if (!agent || kickoffDone.current) return;
    const visitedKey = `meridian-builder.visited.${slug}`;
    if (isWelcome) {
      kickoffDone.current = true;
      localStorage.setItem(visitedKey, '1');
      router.replace(`/agents/${slug}`, { scroll: false });
      const operator = agent.operatorName || 'your operator';
      push({ role: 'sys', text: `✨ ${agent.name} is alive — and remembering starts now.` });
      (async () => {
        const running = agent.gateway.state === 'running' ? true : await startGateway();
        if (!running) return;
        await send(
          `(first meeting) Introduce yourself to ${operator} in two warm sentences in your own voice, then ask one short question that helps you do your job.`,
          { hidden: true },
        );
        push({
          role: 'sys',
          text: `Tell ${agent.name} something about yourself — then refresh this page. It will still know. 🔄`,
        });
      })();
    } else if (localStorage.getItem(visitedKey)) {
      kickoffDone.current = true;
      push({
        role: 'sys',
        text: `Continuing where you left off — ${agent.name} remembers your earlier conversations.`,
      });
    } else {
      kickoffDone.current = true;
    }
  }, [agent, isWelcome, slug, push, router, send, startGateway]);

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    if (gwState !== 'running') {
      push({ role: 'err', text: 'Your agent is paused — press Start in the panel on the right.' });
      return;
    }
    setDraft('');
    send(text);
  }

  if (notFound) {
    return (
      <main>
        <div className="card empty-state">
          No agent named “{slug}” here. <a href="/">Back to your agents</a>
        </div>
      </main>
    );
  }

  return (
    <main className="room">
      <section className="card chat-card">
        <div className="chat-head">
          <div className="who">
            <span className="avatar">{(agent?.name ?? slug).charAt(0).toUpperCase()}</span>
            <div>
              <h3>{agent?.name ?? slug}</h3>
              <span className="status-line">
                <span className={`status-dot ${gwState}`} />
                {gwState === 'running'
                  ? 'online — private local memory'
                  : gwState === 'starting'
                    ? 'waking up…'
                    : 'paused'}
              </span>
            </div>
          </div>
          {persona && (
            <span className="tag">
              {persona.emoji} {persona.title}
            </span>
          )}
        </div>

        <div className="chat-scroll" ref={scrollRef}>
          {messages.length === 0 && gwState === 'running' && (
            <div className="bubble sys">Say hello — {agent?.name ?? 'your agent'} is listening.</div>
          )}
          {messages.map((m, i) => (
            <div key={`${i}-${m.role}`} className={`bubble ${m.role === 'sys' ? 'sys' : m.role === 'err' ? 'err' : m.role}`}>
              {m.text}
            </div>
          ))}
          {busy && (
            <div className="typing-line">
              <span className="tdot" />
              <span className="tdot" />
              <span className="tdot" />
            </div>
          )}
        </div>

        <form className="composer" onSubmit={submit}>
          <textarea
            value={draft}
            placeholder={`Message ${agent?.name ?? 'your agent'}…`}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button type="submit" className="btn primary" disabled={busy || !draft.trim()}>
            Send
          </button>
        </form>
      </section>

      <aside className="rail">
        <div className="card">
          <h4>Memory</h4>
          <div className="memory-chip">🛡️ Private · on this computer · poison-screened</div>
          <p className="subtle" style={{ marginTop: 10, marginBottom: 0 }}>
            {agent?.name ?? 'Your agent'} keeps what you tell it across restarts, and every recalled
            memory passes Meridian’s safety screen first.
          </p>
        </div>

        <div className="card">
          <h4>Status</h4>
          <div className="rail-row">
            <span className="k">Agent</span>
            <span className={`tag ${gwState === 'running' ? 'on' : ''}`}>
              {gwState === 'running' ? 'Running' : gwState === 'starting' ? 'Starting…' : 'Paused'}
            </span>
          </div>
          {agent?.gateway.port && (
            <div className="rail-row">
              <span className="k">Local port</span>
              <span className="subtle">{agent.gateway.port}</span>
            </div>
          )}
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            {gwState === 'running' ? (
              <button type="button" className="btn danger" style={{ flex: 1 }} disabled={gatewayBusy} onClick={stopGateway}>
                Pause
              </button>
            ) : (
              <button type="button" className="btn primary" style={{ flex: 1 }} disabled={gatewayBusy} onClick={startGateway}>
                {gatewayBusy ? 'Starting…' : 'Start'}
              </button>
            )}
          </div>
        </div>

        <div className="card">
          <h4>Channels</h4>
          <div className="rail-row">
            <span className="k">💬 Web chat</span>
            <span className="tag on">On</span>
          </div>
          <div className="rail-row">
            <span className="k">📨 Telegram</span>
            <span className={`tag ${agent?.channels.telegram ? 'soon' : ''}`}>
              {agent?.channels.telegram ? 'Needs token' : 'Off'}
            </span>
          </div>
          <div className="rail-row">
            <span className="k">📞 Voice</span>
            <span className={`tag ${agent?.channels.voice ? 'soon' : ''}`}>
              {agent?.channels.voice ? 'Needs number' : 'Off'}
            </span>
          </div>
        </div>

        {agent && agent.skills.length > 0 && (
          <div className="card">
            <h4>Skills</h4>
            {agent.skills.includes('web-search') && (
              <div className="rail-row">
                <span className="k">🔎 Web search</span>
                <span className="tag on">Ready</span>
              </div>
            )}
            {agent.skills.includes('github') && (
              <div className="rail-row">
                <span className="k">🐙 GitHub</span>
                <span className="tag soon">Connect later</span>
              </div>
            )}
            {agent.skills.includes('google') && (
              <div className="rail-row">
                <span className="k">📅 Google</span>
                <span className="tag soon">Connect later</span>
              </div>
            )}
          </div>
        )}

        {persona && agent && (
          <div className="card">
            <h4>Personality</h4>
            <p className="subtle" style={{ margin: 0 }}>{persona.tagline}</p>
          </div>
        )}

        <div className="card deploy-stub">
          <button type="button" className="btn ghost" disabled aria-disabled="true">
            Deploy to Meridian Cloud →
          </button>
          <p>Coming soon — always-on hosting, phone number included.</p>
        </div>
      </aside>
    </main>
  );
}
