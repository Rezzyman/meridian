/**
 * CORTEX stand-in for evals — a contract-faithful HTTP server speaking
 * CortexBind's exact surface (/api/v1/recall, /ingest, /health, /dream,
 * /artifacts, /reconsolidate), backed by an in-memory, agent-namespaced
 * store with naive token-overlap scoring.
 *
 * THIS IS NOT CORTEX. No hippocampal pipeline, no valence dynamics, no
 * dream consolidation — it exists so the meridian runtime's memory
 * plumbing (recall → <cortex_recall> prompt block → encode) can be
 * exercised LIVE end-to-end when a real CORTEX instance cannot be
 * provisioned. Eval results against it measure meridian, not CORTEX.
 */

import { createServer, type Server } from 'node:http';

interface StoredMemory {
  id: number;
  agentId: string;
  content: string;
  source: string;
  sensitivity: string;
  createdAt: string;
}

export interface StandInHandle {
  server: Server;
  port: number;
  /** All memories, for assertions. */
  dump(): StoredMemory[];
  close(): Promise<void>;
}

function score(query: string, content: string): number {
  const q = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
  const c = new Set(content.toLowerCase().split(/\W+/).filter(Boolean));
  let hit = 0;
  for (const w of q) if (c.has(w)) hit++;
  return q.size ? hit / q.size : 0;
}

export function startCortexStandIn(port = 0): Promise<StandInHandle> {
  const memories: StoredMemory[] = [];
  let nextId = 1;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const readBody = (): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        let buf = '';
        req.on('data', (c) => {
          buf += c;
        });
        req.on('end', () => {
          try {
            resolve(JSON.parse(buf || '{}'));
          } catch {
            resolve({});
          }
        });
      });

    void (async () => {
      if (req.method === 'GET' && url.pathname === '/api/v1/health') {
        return send(200, { status: 'ok', database: 'connected', memoryCount: memories.length });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/recall') {
        const body = await readBody();
        const agentId = String(body.agentId ?? '');
        const query = String(body.query ?? '');
        const filter = (body.sensitivityFilter as string[] | undefined) ?? undefined;
        const hits = memories
          .filter((m) => m.agentId === agentId)
          .filter((m) => !filter || filter.includes(m.sensitivity))
          .map((m) => ({ m, s: score(query, m.content) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, 8);
        const context = hits.map((h) => `- ${h.m.content}`).join('\n');
        return send(200, {
          context,
          memories: hits.map((h) => ({
            id: h.m.id,
            content: h.m.content,
            source: h.m.source,
            score: h.s,
          })),
          artifacts: [],
          tokenCount: Math.ceil(context.length / 4),
          tokenBudget: Number(body.tokenBudget ?? 4000),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/ingest') {
        const body = await readBody();
        const mem: StoredMemory = {
          id: nextId++,
          agentId: String(body.agentId ?? ''),
          content: String(body.content ?? ''),
          source: String(body.source ?? 'unknown'),
          sensitivity: String(body.sensitivity ?? 'internal'),
          createdAt: new Date().toISOString(),
        };
        memories.push(mem);
        return send(200, { memoryId: mem.id, novelty: 0.5, encoded: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/dream') {
        return send(200, { cycleType: 'full', durationMs: 1, insights: [], stats: {} });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/artifacts') {
        return send(200, {
          agentId: url.searchParams.get('agentId') ?? '',
          sinceHours: 48,
          cutoff: new Date().toISOString(),
          count: 0,
          artifacts: [],
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/reconsolidate') {
        return send(200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/memories/agents') {
        return send(200, { agents: [] });
      }
      send(404, { error: `no route ${req.method} ${url.pathname}` });
    })();
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        port: boundPort,
        dump: () => [...memories],
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
