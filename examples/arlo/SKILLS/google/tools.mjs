// Arlo google skill (service-account edition): Gmail + Google Calendar as
// first-class Meridian tools. Everything shells out to the two CLIs in the
// agent home's bin/, which authenticate with the ATERNA Google service account
// (domain-wide delegation). No OAuth click, no browser, no app password.
//
// Paths resolve from this file's location (SKILLS/google/tools.mjs -> agent
// home), so a bench copy of the home works unchanged. The service-account
// secrets, the signature file, and the Python venv live in the REAL Arlo home;
// point GOOGLE_SA_HOME elsewhere only if they move.
//
// Every tool returns { error } when a Google scope is not delegated yet. Nothing
// is ever fabricated and nothing is ever sent by a draft or a schedule call
// without the operator seeing it first.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_HOME = join(SKILL_DIR, '..', '..');
const SA_HOME = process.env.GOOGLE_SA_HOME || '/root/.meridian/arlo';
const PYTHON =
  process.env.GOOGLE_SA_PYTHON ||
  (existsSync(join(AGENT_HOME, 'email-venv/bin/python'))
    ? join(AGENT_HOME, 'email-venv/bin/python')
    : join(SA_HOME, 'email-venv/bin/python'));
const BIN = existsSync(join(AGENT_HOME, 'bin/arlo-gmail.py'))
  ? join(AGENT_HOME, 'bin')
  : join(SA_HOME, 'bin');
const GMAIL = join(BIN, 'arlo-gmail.py');
const CAL = join(BIN, 'arlo-calendar.py');
const DEFAULT_ACCOUNT = 'ajuarez@aterna.ai';
const SEND_FROM = 'arlo@aterna.ai';

function runPy(script, cliArgs, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile(
      PYTHON,
      [script, ...cliArgs],
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ARLO_HOME: SA_HOME },
      },
      (err, stdout, stderr) => {
        const out = (stdout || '').trim();
        const errText = (stderr || '').trim();
        if (err && !out) resolve({ ok: false, error: errText || err.message || 'cli failed' });
        else resolve({ ok: true, output: out });
      },
    );
  });
}

/** The calendar CLI always prints one JSON line; surface { error } as a tool error. */
function parseJson(r) {
  if (!r.ok) return { error: r.error };
  try {
    const j = JSON.parse(r.output);
    return j;
  } catch {
    return { error: `unexpected CLI output: ${r.output.slice(0, 200)}` };
  }
}

function clamp(n, lo, hi, dflt) {
  const v = Number.isFinite(n) ? n : dflt;
  return Math.min(Math.max(v, lo), hi);
}

function createTools(ctx) {
  const { tool, z } = ctx;

  const readById = async (args, name) => {
    if (!args.id || !args.id.trim()) return { error: `${name} requires a message id` };
    const cli = ['read', '--id', args.id];
    if (args.account) cli.push('--account', args.account);
    const r = await runPy(GMAIL, cli);
    return r.ok
      ? { account: args.account ?? DEFAULT_ACCOUNT, id: args.id, output: r.output }
      : { error: r.error };
  };

  return {
    gmail_recent: tool({
      description:
        "List recent inbox messages, pulled LIVE from Gmail this run. Defaults to Atanasio's inbox (ajuarez@aterna.ai). Optionally unread-only or filtered by a Gmail query. Returns sender, subject, date, snippet, and message id.",
      parameters: z.object({
        account: z
          .string()
          .optional()
          .describe('Mailbox (default ajuarez@aterna.ai; also arlo@aterna.ai)'),
        max: z.number().default(10).describe('Max messages (1-25)'),
        unread: z.boolean().default(false).describe('Only unread messages'),
        query: z.string().optional().describe('Optional extra Gmail query'),
      }),
      execute: async (args) => {
        const cli = ['recent', '--max', String(clamp(args.max, 1, 25, 10))];
        if (args.account) cli.push('--account', args.account);
        if (args.unread) cli.push('--unread');
        if (args.query) cli.push('--query', args.query);
        const r = await runPy(GMAIL, cli);
        return r.ok
          ? { account: args.account ?? DEFAULT_ACCOUNT, output: r.output }
          : { error: r.error };
      },
    }),
    gmail_search: tool({
      description:
        'Search Gmail with standard query syntax (e.g. "from:jeff@x.com newer_than:7d", "is:unread", "subject:invoice"). Live this run.',
      parameters: z.object({
        query: z.string().describe('Gmail query string (required)'),
        account: z.string().optional().describe('Mailbox (default ajuarez@aterna.ai)'),
        max: z.number().default(10).describe('Max results (1-25)'),
      }),
      execute: async (args) => {
        if (!args.query || !args.query.trim())
          return { error: 'gmail_search requires a non-empty query' };
        const cli = ['search', '--query', args.query, '--max', String(clamp(args.max, 1, 25, 10))];
        if (args.account) cli.push('--account', args.account);
        const r = await runPy(GMAIL, cli);
        return r.ok
          ? { account: args.account ?? DEFAULT_ACCOUNT, query: args.query, output: r.output }
          : { error: r.error };
      },
    }),
    gmail_read: tool({
      description:
        'Fetch the full body of one Gmail message by id (ids come from gmail_recent / gmail_search). Live this run.',
      parameters: z.object({
        id: z.string().describe('Gmail message id'),
        account: z.string().optional().describe('Mailbox (default ajuarez@aterna.ai)'),
      }),
      execute: async (args) => readById(args, 'gmail_read'),
    }),
    gmail_get: tool({
      description:
        'Same as gmail_read: full body of one Gmail message by id. Kept so both tool names resolve.',
      parameters: z.object({
        id: z.string().describe('Gmail message id'),
        account: z.string().optional().describe('Mailbox (default ajuarez@aterna.ai)'),
      }),
      execute: async (args) => readById(args, 'gmail_get'),
    }),
    gmail_pending: tool({
      description:
        'List arlo@aterna.ai inbox threads whose newest message is external and therefore still needs a reply. This does not rely on unread state. Returns message and thread ids for safe, idempotent processing.',
      parameters: z.object({
        max: z.number().default(10).describe('Max pending threads (1-25)'),
        query: z.string().optional().describe('Optional Gmail query override'),
      }),
      execute: async (args) => {
        const cli = [
          'pending',
          '--account',
          SEND_FROM,
          '--max',
          String(clamp(args.max, 1, 25, 10)),
        ];
        if (args.query) cli.push('--query', args.query);
        const r = await runPy(GMAIL, cli);
        return r.ok ? { account: SEND_FROM, output: r.output } : { error: r.error };
      },
    }),
    gmail_draft: tool({
      description:
        'Save a real Gmail DRAFT in arlo@aterna.ai (it appears in the Drafts folder for a human to edit or send). Always from arlo@, always CC ajuarez@, signature appended, optional in-thread reply. Never sends. Use this when the operator asks to draft, write up, or prepare an email.',
      parameters: z.object({
        to: z.string().describe('Recipient email(s), comma-separated'),
        subject: z.string().describe('Subject line'),
        body: z.string().describe('Plain-text body (no em-dashes)'),
        cc: z.string().optional().describe('Extra CC addresses'),
        replyTo: z.string().optional().describe('Gmail message id to reply to in-thread'),
      }),
      execute: async (args) => {
        if (!args.to || !args.subject || !args.body)
          return { error: 'gmail_draft requires to, subject, and body' };
        const cli = ['draft', '--to', args.to, '--subject', args.subject, '--body', args.body];
        if (args.cc) cli.push('--cc', args.cc);
        if (args.replyTo) cli.push('--reply-to', args.replyTo);
        return parseJson(await runPy(GMAIL, cli, 45000));
      },
    }),
    gmail_send: tool({
      description:
        "Compose or reply to an email from arlo@aterna.ai, always CCing ajuarez@aterna.ai and appending Arlo's signature. confirm:false previews only. confirm:true is governance-gated: it requires a scoped human approval grant AND an explicit send instruction from the operator in the current conversation. Never infer approval from task context; 'Rez wants these out' is not approval to send unreviewed drafts.",
      parameters: z.object({
        to: z.string().describe('Recipient email(s), comma-separated'),
        subject: z.string().describe('Subject line'),
        body: z.string().describe('Plain-text body (no em-dashes)'),
        cc: z.string().optional().describe('Extra CC addresses'),
        replyTo: z.string().optional().describe('Gmail message id to reply to in-thread'),
        confirm: z.boolean().default(false).describe('false = preview only; true = actually send'),
      }),
      execute: async (args) => {
        if (!args.to || !args.subject || !args.body)
          return { error: 'gmail_send requires to, subject, and body' };
        const cli = ['send', '--to', args.to, '--subject', args.subject, '--body', args.body];
        if (args.cc) cli.push('--cc', args.cc);
        if (args.replyTo) cli.push('--reply-to', args.replyTo);
        if (args.confirm === true) cli.push('--confirm');
        const r = await runPy(GMAIL, cli, 45000);
        return r.ok
          ? { sent: args.confirm === true, from: SEND_FROM, output: r.output }
          : { error: r.error };
      },
    }),
    gcal_today: tool({
      description:
        "Today's events on the operator's primary Google Calendar (America/Denver day), pulled live. Returns { error } if the calendar scope is not delegated yet; never invents events.",
      parameters: z.object({
        account: z.string().optional().describe('Calendar owner (default ajuarez@aterna.ai)'),
      }),
      execute: async (args) => {
        const cli = ['today'];
        if (args.account) cli.push('--account', args.account);
        return parseJson(await runPy(CAL, cli));
      },
    }),
    gcal_upcoming: tool({
      description:
        "Upcoming events for the next N days (1-30) on the operator's primary Google Calendar, pulled live.",
      parameters: z.object({
        days: z.number().default(7).describe('Days ahead (1-30)'),
        account: z.string().optional().describe('Calendar owner (default ajuarez@aterna.ai)'),
      }),
      execute: async (args) => {
        const cli = ['upcoming', '--days', String(clamp(args.days, 1, 30, 7))];
        if (args.account) cli.push('--account', args.account);
        return parseJson(await runPy(CAL, cli));
      },
    }),
    gcal_schedule: tool({
      description:
        "Create an event on the operator's primary Google Calendar. Times are ISO 8601; a time without a zone is America/Denver. Attendees receive invites. Confirm the details with the operator before calling unless they gave them all explicitly.",
      parameters: z.object({
        summary: z.string().describe('Event title'),
        start: z.string().describe('Start, ISO 8601 (e.g. 2026-09-25T14:00)'),
        end: z.string().optional().describe('End, ISO 8601 (default start + 30 min)'),
        attendees: z.string().optional().describe('Comma-separated attendee emails'),
        location: z.string().optional().describe('Location or meeting link'),
        description: z.string().optional().describe('Event description'),
        account: z.string().optional().describe('Calendar owner (default ajuarez@aterna.ai)'),
      }),
      execute: async (args) => {
        if (!args.summary || !args.start)
          return { error: 'gcal_schedule requires summary and start' };
        const cli = ['schedule', '--summary', args.summary, '--start', args.start];
        if (args.end) cli.push('--end', args.end);
        if (args.attendees) cli.push('--attendees', args.attendees);
        if (args.location) cli.push('--location', args.location);
        if (args.description) cli.push('--description', args.description);
        if (args.account) cli.push('--account', args.account);
        return parseJson(await runPy(CAL, cli, 45000));
      },
    }),
  };
}

export { createTools };
