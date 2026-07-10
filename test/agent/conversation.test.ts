/**
 * Conversation — stateful wrapper around runTurn. History bookkeeping,
 * trace persistence (best-effort), reset, and the resume-from-store path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conversation } from '../../src/agent/conversation.js';
import type { ConversationOptions } from '../../src/agent/conversation.js';
import type { MeridianSession, MeridianTurn } from '../../src/agent/types.js';
import type { SessionStore, TurnTrace } from '../../src/session/store.js';
import { makeConfig, mockCortex, mockRouter, silentLogger, textModel } from '../helpers/fixtures.js';

function makeConversation(extra: Partial<ConversationOptions> = {}): Conversation {
  return new Conversation({
    config: makeConfig(),
    cortex: mockCortex(),
    router: mockRouter(textModel('mock reply')),
    logger: silentLogger,
    systemBase: 'system base',
    channel: 'cli',
    ...extra,
  });
}

/** SessionStore stub: records recordTrace calls; everything else is unused by Conversation. */
function traceStore(opts: { throwOnRecord?: boolean } = {}): {
  store: SessionStore;
  traces: TurnTrace[];
} {
  const traces: TurnTrace[] = [];
  const store = {
    recordTrace(t: TurnTrace) {
      if (opts.throwOnRecord) throw new Error('disk full');
      traces.push(t);
    },
  } as unknown as SessionStore;
  return { store, traces };
}

function pastTurn(role: 'user' | 'assistant' | 'tool', content: string, i: number): MeridianTurn {
  return {
    id: `t_resume_${i}`,
    sessionId: 'sess-resume',
    role,
    content,
    channel: 'cli',
    ts: new Date(1700000000000 + i * 1000).toISOString(),
  };
}

function resumeSession(turns: MeridianTurn[]): MeridianSession {
  return {
    id: 'sess-resume',
    agentSlug: 'test-agent',
    createdAt: new Date(1700000000000).toISOString(),
    turns,
  };
}

test('send() returns the assistant turn and pushes user+assistant into history', async () => {
  const conv = makeConversation();
  const turn = await conv.send('hello agent');

  assert.equal(turn.role, 'assistant');
  assert.equal(turn.content, 'mock reply');
  assert.equal(turn.sessionId, conv.sessionId);
  assert.equal(conv.historyCount, 2); // one user + one assistant entry

  const snap = conv.snapshot();
  assert.equal(snap.id, conv.sessionId);
  assert.equal(snap.turns.length, 2);
  assert.equal(snap.turns[0].role, 'user');
  assert.equal(snap.turns[0].content, 'hello agent');
  assert.equal(snap.turns[1].role, 'assistant');
  assert.equal(snap.turns[1].content, 'mock reply');
});

test('history trims to MAX_HISTORY_ENTRIES (16) after more than 8 sends', async () => {
  const conv = makeConversation();
  for (let i = 0; i < 10; i++) {
    await conv.send(`message number ${i}`);
  }
  // 10 sends produce 20 history entries; trimmed to the most recent 16.
  assert.equal(conv.historyCount, 16);
  // snapshot turns are NOT trimmed — full transcript is retained.
  assert.equal(conv.snapshot().turns.length, 20);
});

test('store.recordTrace receives a TurnTrace with sessionId, model, and toolCalls', async () => {
  const { store, traces } = traceStore();
  const conv = makeConversation({ store });
  const turn = await conv.send('what backed that claim');

  assert.equal(traces.length, 1);
  const t = traces[0];
  assert.equal(t.turnId, turn.id);
  assert.equal(t.sessionId, conv.sessionId);
  assert.equal(t.channel, 'cli');
  assert.equal(t.model, 'anthropic/mock-0'); // ResolvedProvider.ref from mockRouter
  assert.ok(Array.isArray(t.toolCalls), 'toolCalls is an array');
  assert.equal(t.toolCalls?.length, 0);
  assert.equal(t.userInput, 'what backed that claim');
  assert.equal(t.reply, 'mock reply');
  assert.equal(t.recallQuery, 'what backed that claim');
  assert.deepEqual(t.recallMemoryIds, [1]); // mockCortex default memory
  assert.equal(typeof t.durationMs, 'number');
  assert.equal(typeof t.ts, 'string');
});

test('store.recordTrace throwing is swallowed — the turn still succeeds', async () => {
  const { store, traces } = traceStore({ throwOnRecord: true });
  const conv = makeConversation({ store });

  const turn = await conv.send('hello despite the broken store');
  assert.equal(turn.content, 'mock reply');
  assert.equal(conv.historyCount, 2);
  assert.equal(traces.length, 0);
});

test('reset() clears history and turns; the conversation is reusable after', async () => {
  const conv = makeConversation();
  await conv.send('first message');
  assert.equal(conv.historyCount, 2);

  conv.reset();
  assert.equal(conv.historyCount, 0);
  assert.equal(conv.snapshot().turns.length, 0);

  await conv.send('fresh start');
  assert.equal(conv.historyCount, 2);
});

test('resume: prior user/assistant turns load into history and the session id is kept', async () => {
  const resume = resumeSession([
    pastTurn('user', 'earlier question', 0),
    pastTurn('assistant', 'earlier answer', 1),
  ]);
  const conv = makeConversation({ resume });

  assert.equal(conv.sessionId, 'sess-resume');
  assert.equal(conv.historyCount, 2);
  assert.equal(conv.snapshot().turns.length, 2);

  const turn = await conv.send('and a follow-up');
  assert.equal(turn.content, 'mock reply');
  assert.equal(turn.sessionId, 'sess-resume');
  assert.equal(conv.historyCount, 4);
});

test('resume: loaded history is trimmed to 16 entries; snapshot keeps the full transcript', () => {
  const turns: MeridianTurn[] = [];
  for (let i = 0; i < 20; i++) {
    turns.push(pastTurn(i % 2 === 0 ? 'user' : 'assistant', `turn ${i}`, i));
  }
  const conv = makeConversation({ resume: resumeSession(turns) });
  assert.equal(conv.historyCount, 16);
  assert.equal(conv.snapshot().turns.length, 20);
});

// Pins CURRENT behavior of the suspected role:'tool' resume bug: a resumed
// tool turn is pushed as { role: 'tool', content: '<string>' }, which is not
// a valid CoreMessage (tool content must be an array of tool-result parts).
// The AI SDK rejects the prompt on the next send, so every provider in the
// chain "fails" and the turn throws. If this assertion starts failing, the
// resume mapping in Conversation's constructor was probably fixed.
test('resume: a role:tool turn poisons history — next send() rejects (current behavior)', async () => {
  const resume = resumeSession([
    pastTurn('user', 'run the tool', 0),
    pastTurn('tool', 'raw tool output as a string', 1),
    pastTurn('assistant', 'done', 2),
  ]);
  const conv = makeConversation({ resume });
  assert.equal(conv.historyCount, 3); // it loads fine; the failure is at send time

  // RULE ZERO: the surfaced message is the client-safe generic, not raw provider detail.
  await assert.rejects(conv.send('continue'), /Quick hiccup on my end/);
});
