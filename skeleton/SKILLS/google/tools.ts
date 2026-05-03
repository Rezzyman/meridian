/**
 * Google skill tools — Gmail, Calendar, Drive via the bundled `gog` CLI
 * (steipete/gogcli, MIT, vendored at runtime by Meridian's gog resolver).
 *
 * Each Meridian agent gets its own OAuth client bucket name in gog,
 * so two agents on the same machine cannot see each other's mailboxes.
 * The bucket name is `<agent>-meridian` (e.g. `aria-meridian`).
 *
 * Multi-mailbox: every tool takes an `account` parameter and dispatches
 * to gog with --account. The skill's setup walkthrough records which
 * accounts are authorized in the agent's vault under
 * `skill.google.accounts` so the model knows the addressable surface.
 *
 * Read-mostly safety: gmail_draft and gcal_schedule create DRAFT artifacts
 * by default. gmail_send and gcal_create require an explicit confirm:true
 * flag. The model is instructed in SKILL.md to surface drafts for operator
 * approval before any send.
 */

// Skill runtime contract — Meridian provides this object to createTools()
// at registration. Inline type, no external import needed (skills run from
// the agent's home, not the meridian node_modules tree).
interface SkillToolContext {
  cortex: {
    encode(content: string, opts: {
      source?: string;
      priority?: number;
      sensitivity?: 'public' | 'internal' | 'sacred';
    }): Promise<{ memoryId?: number } & Record<string, unknown>>;
  };
  vault: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    setMany(entries: Record<string, unknown>): void;
    has(key: string): boolean;
  };
  env: Record<string, string | undefined> & { CORTEX_AGENT_ID?: string };
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  requirePassphrase: (skillName: string, candidate?: string) => void;
  tool: (def: unknown) => unknown;
  z: {
    object: (shape: Record<string, unknown>) => unknown;
    string: () => { describe: (s: string) => unknown; optional: () => unknown; default: (v: string) => unknown };
    number: () => { default: (n: number) => { describe: (s: string) => unknown } };
    boolean: () => { default: (v: boolean) => { describe: (s: string) => unknown } };
  };
  /** Meridian-bundled tools. Skills use these instead of importing
   *  meridian internals directly (skill files live in the agent's home,
   *  not the meridian source tree, so relative imports don't resolve). */
  tools: {
    gog: {
      run: (opts: { args: string[]; client: string; account?: string; json?: boolean; timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
      runJson: <T = unknown>(opts: { args: string[]; client: string; account?: string; timeoutMs?: number }) => Promise<T>;
    };
  };
}

interface AuthorizedAccount {
  email: string;
  /** OAuth client bucket this account's tokens live under. Optional —
   *  defaults to the agent-level client (vault `skill.google.client`,
   *  which itself defaults to `<agent>-meridian`). Per-account override
   *  exists so operators with pre-existing gog auth across multiple
   *  client buckets (e.g. OpenClaw migrations) don't have to re-auth. */
  client?: string;
  scopes?: string[];
}

interface ResolvedAccount {
  email: string;
  client: string;
}

/**
 * Default OAuth client bucket for this agent when an account doesn't
 * specify its own. New Meridian users land here for everything; existing
 * gog users can override per-account in the authorized list.
 */
function defaultClient(ctx: SkillToolContext): string {
  const override = ctx.vault.get<string>('skill.google.client');
  if (override) return override;
  const agentId = ctx.env.CORTEX_AGENT_ID ?? 'agent';
  return `${agentId}-meridian`;
}

/**
 * Choose which mailbox to address and which client bucket holds its
 * tokens. If the operator passed an `account` arg, validate against the
 * authorized list. Otherwise default to the first-authorized account.
 */
function pickAccount(ctx: SkillToolContext, requested?: string): ResolvedAccount {
  const accounts = ctx.vault.get<AuthorizedAccount[]>('skill.google.accounts') ?? [];
  if (accounts.length === 0) {
    throw new Error(
      'google skill not configured: no accounts authorized. run `meridian skills setup google` to authorize one or more mailboxes.',
    );
  }
  const resolve = (a: AuthorizedAccount): ResolvedAccount => ({
    email: a.email,
    client: a.client ?? defaultClient(ctx),
  });
  if (requested) {
    const match = accounts.find((a) => a.email.toLowerCase() === requested.toLowerCase());
    if (!match) {
      throw new Error(
        `account "${requested}" is not authorized for this agent. authorized: ${accounts.map((a) => a.email).join(', ')}`,
      );
    }
    return resolve(match);
  }
  return resolve(accounts[0]);
}

interface SetupCtx {
  vault: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    has(key: string): boolean;
  };
  env: Record<string, string | undefined>;
  agentSlug: string;
  prompt: (question: string, opts?: { mask?: boolean }) => Promise<string>;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  err: (msg: string) => void;
  tools: {
    gog: {
      run: (opts: { args: string[]; client: string; account?: string; json?: boolean; timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
      listAccounts: (client: string) => Promise<Array<{ email: string; client: string; scopes: string; expires?: string; type: string }>>;
      spawnLogin: (email: string, client: string) => Promise<number>;
    };
  };
}

/**
 * Interactive setup walkthrough for the google skill.
 *
 * Resolves the bundled gog binary (downloads on first run), shows what is
 * already authorized in this agent's client bucket, and offers to authorize
 * additional mailboxes via gog's interactive OAuth flow. The authorized
 * account list is mirrored into the vault under `skill.google.accounts`.
 */
export async function setup(ctx: SetupCtx): Promise<void> {
  const clientBucket = ctx.vault.get<string>('skill.google.client') ?? `${ctx.agentSlug}-meridian`;
  ctx.log(`gog client bucket for this agent: ${clientBucket}`);

  ctx.log('resolving gog binary (downloads on first run)...');
  let authorized: Array<{ email: string }> = [];
  try {
    const accounts = await ctx.tools.gog.listAccounts(clientBucket);
    authorized = accounts.map((a) => ({ email: a.email }));
  } catch (err) {
    ctx.err(`gog could not be resolved or run: ${(err as Error).message}`);
    return;
  }

  if (authorized.length > 0) {
    ctx.log(`already authorized in ${clientBucket}:`);
    for (const a of authorized) ctx.log(`  - ${a.email}`);
  } else {
    ctx.log(`no accounts authorized in ${clientBucket} yet.`);
  }

  while (true) {
    const proceed = await ctx.prompt('Authorize a new mailbox? [y/N]:');
    if (!/^y(es)?$/i.test(proceed)) break;

    const email = (await ctx.prompt('Email to authorize:')).trim();
    if (!email || !email.includes('@')) {
      ctx.warn('that does not look like an email. skipping.');
      continue;
    }
    if (authorized.some((a) => a.email.toLowerCase() === email.toLowerCase())) {
      ctx.log(`${email} is already authorized in this bucket. skipping.`);
      continue;
    }

    ctx.log('opening browser for Google consent. follow the prompts in your terminal.');
    const code = await ctx.tools.gog.spawnLogin(email, clientBucket);
    if (code !== 0) {
      ctx.err(`gog auth login exited with code ${code}. ${email} not added.`);
      continue;
    }
    authorized.push({ email });
    ctx.log(`${email} authorized.`);
  }

  if (authorized.length === 0) {
    ctx.warn('no mailboxes authorized. the google skill needs at least one to function.');
    return;
  }

  const accountsForVault = authorized.map((a) => ({ email: a.email }));
  ctx.vault.set('skill.google.accounts', accountsForVault);
  ctx.log(`stored ${accountsForVault.length} account(s) under skill.google.accounts.`);

  if (process.platform === 'darwin') {
    ctx.log('macOS note: the first runtime call may surface a Keychain prompt — click "Always Allow".');
  }
}

export function createTools(ctx: SkillToolContext): Record<string, unknown> {
  const { tool, z } = ctx;
  const Z = z as unknown as {
    object: (shape: Record<string, unknown>) => unknown;
    string: () => { describe: (s: string) => unknown; optional: () => unknown; default: (v: string) => unknown };
    number: () => { default: (n: number) => { describe: (s: string) => unknown } };
    boolean: () => { default: (v: boolean) => { describe: (s: string) => unknown } };
  };

  // Use the bundled gog tool injected by Meridian's runtime. No filesystem
  // imports — skills are portable across install locations.
  async function gogJson<T = unknown>(args: string[], acct: ResolvedAccount): Promise<T> {
    return ctx.tools.gog.runJson<T>({ args, account: acct.email, client: acct.client });
  }
  async function gogRun(args: string[], acct: ResolvedAccount): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return ctx.tools.gog.run({ args, account: acct.email, client: acct.client });
  }

  return {
    // ── Gmail ─────────────────────────────────────────────────────────
    gmail_search: tool({
      description:
        "Search a Gmail mailbox using Gmail's standard query syntax " +
        '(e.g. "from:jeff@example.com newer_than:7d", "is:unread", "subject:invoice"). ' +
        'Returns sender, subject, date, and snippet for each match. ' +
        'Pass `account` to target a specific mailbox; omit to use the primary.',
      parameters: Z.object({
        query: Z.string().describe('Gmail query string'),
        account: Z.string().optional().describe('Mailbox email (omit for primary)'),
        maxResults: Z.number().default(10).describe('Max messages to return (1-50)'),
      }),
      execute: async (args: { query: string; account?: string; maxResults: number }) => {
        const acct = pickAccount(ctx, args.account);
        const max = Math.min(Math.max(args.maxResults, 1), 50);
        try {
          const result = await gogJson<{ messages?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(
            ['gmail', 'messages', 'search', args.query, '--max', String(max)],
            acct,
          );
          const messages = Array.isArray(result) ? result : (result.messages ?? []);
          return { account: acct.email, query: args.query, count: messages.length, messages };
        } catch (err) {
          return { error: (err as Error).message, account: acct.email, query: args.query };
        }
      },
    }),

    gmail_get: tool({
      description:
        'Fetch the full body of a Gmail message by id (e.g. ids returned by gmail_search). ' +
        'Use this to read a message before drafting a reply.',
      parameters: Z.object({
        messageId: Z.string().describe('Gmail message id'),
        account: Z.string().optional().describe('Mailbox the message lives in'),
      }),
      execute: async (args: { messageId: string; account?: string }) => {
        const acct = pickAccount(ctx, args.account);
        try {
          const result = await gogJson(['gmail', 'get', args.messageId, '--format', 'full'], acct);
          return { account: acct.email, message: result };
        } catch (err) {
          return { error: (err as Error).message, account: acct.email, messageId: args.messageId };
        }
      },
    }),

    gmail_draft: tool({
      description:
        "Create a Gmail DRAFT (not send). The draft sits in the operator's Drafts folder " +
        'until they explicitly send it from Gmail or call gmail_send with confirm:true.',
      parameters: Z.object({
        to: Z.string().describe('Recipient email address'),
        subject: Z.string().describe('Subject line'),
        body: Z.string().describe('Plain-text body'),
        threadId: Z.string().optional().describe('Optional Gmail thread id (for replies)'),
        account: Z.string().optional().describe('Sending mailbox'),
      }),
      execute: async (args: { to: string; subject: string; body: string; threadId?: string; account?: string }) => {
        const acct = pickAccount(ctx, args.account);
        const cli = ['gmail', 'draft', 'create', '--to', args.to, '--subject', args.subject, '--body', args.body];
        if (args.threadId) cli.push('--thread-id', args.threadId);
        try {
          const result = await gogJson<Record<string, unknown>>(cli, acct);
          return { account: acct.email, draft: result };
        } catch (err) {
          return { error: (err as Error).message, account: acct.email, to: args.to };
        }
      },
    }),

    // ── Calendar ──────────────────────────────────────────────────────
    gcal_today: tool({
      description: "List today's events on the operator's primary calendar.",
      parameters: Z.object({
        account: Z.string().optional().describe('Mailbox whose calendar to read'),
      }),
      execute: async (args: { account?: string }) => {
        const acct = pickAccount(ctx, args.account);
        const today = new Date().toISOString().slice(0, 10);
        try {
          const result = await gogJson<{ events?: Array<unknown> } | Array<unknown>>(
            ['calendar', 'events', '--time-min', `${today}T00:00:00Z`, '--time-max', `${today}T23:59:59Z`],
            acct,
          );
          const events = Array.isArray(result) ? result : (result.events ?? []);
          return { account: acct.email, date: today, count: events.length, events };
        } catch (err) {
          return { error: (err as Error).message, account: acct.email, date: today };
        }
      },
    }),

    gcal_upcoming: tool({
      description: 'List upcoming calendar events for the next N days.',
      parameters: Z.object({
        days: Z.number().default(7).describe('Days ahead (1-30)'),
        account: Z.string().optional().describe('Mailbox whose calendar to read'),
      }),
      execute: async (args: { days: number; account?: string }) => {
        const acct = pickAccount(ctx, args.account);
        const days = Math.min(Math.max(args.days, 1), 30);
        const start = new Date();
        const end = new Date(start.getTime() + days * 24 * 3600 * 1000);
        try {
          const result = await gogJson<{ events?: Array<unknown> } | Array<unknown>>(
            ['calendar', 'events', '--time-min', start.toISOString(), '--time-max', end.toISOString()],
            acct,
          );
          const events = Array.isArray(result) ? result : (result.events ?? []);
          return {
            acct,
            range: { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) },
            count: events.length,
            events,
          };
        } catch (err) {
          return { error: (err as Error).message, account };
        }
      },
    }),

    gcal_schedule: tool({
      description:
        'Draft (or with confirm:true, create) a calendar event. Without confirm, returns the draft details ' +
        'so the operator can approve before final create.',
      parameters: Z.object({
        summary: Z.string().describe('Event title'),
        startIso: Z.string().describe('Start time as ISO 8601'),
        endIso: Z.string().describe('End time as ISO 8601'),
        description: Z.string().optional().describe('Optional event description'),
        attendees: Z.string().optional().describe('Comma-separated attendee emails'),
        account: Z.string().optional().describe('Mailbox owning the event'),
        confirm: Z.boolean().default(false).describe('false = preview only; true = actually create'),
      }),
      execute: async (args: {
        summary: string; startIso: string; endIso: string;
        description?: string; attendees?: string; account?: string; confirm: boolean;
      }) => {
        const acct = pickAccount(ctx, args.account);
        const draft = {
          summary: args.summary,
          start: args.startIso,
          end: args.endIso,
          description: args.description,
          attendees: args.attendees?.split(',').map((s) => s.trim()).filter(Boolean) ?? [],
        };
        if (!args.confirm) {
          return { account: acct.email, draft, note: 'pass confirm:true to actually create this event' };
        }
        const cli = [
          'calendar', 'events', 'create',
          '--summary', args.summary,
          '--start', args.startIso,
          '--end', args.endIso,
        ];
        if (args.description) cli.push('--description', args.description);
        if (draft.attendees.length) cli.push('--attendees', draft.attendees.join(','));
        try {
          const result = await gogJson<Record<string, unknown>>(cli, acct);
          return { account: acct.email, event: result };
        } catch (err) {
          return { error: (err as Error).message, account: acct.email, draft };
        }
      },
    }),

    // ── Drive ─────────────────────────────────────────────────────────
    gdrive_search: tool({
      description:
        "Search Google Drive for files. Returns id, name, mimeType, modifiedTime.",
      parameters: Z.object({
        query: Z.string().describe('Drive search query (e.g. "Q3 plans")'),
        account: Z.string().optional().describe("Drive owner's mailbox"),
        maxResults: Z.number().default(10).describe('Max results (1-30)'),
      }),
      execute: async (args: { query: string; account?: string; maxResults: number }) => {
        const acct = pickAccount(ctx, args.account);
        const max = Math.min(Math.max(args.maxResults, 1), 30);
        try {
          const result = await gogJson<{ files?: Array<unknown> } | Array<unknown>>(
            ['drive', 'find', args.query, '--max', String(max)],
            acct,
          );
          const files = Array.isArray(result) ? result : (result.files ?? []);
          return { account: acct.email, query: args.query, count: files.length, files };
        } catch (err) {
          return { error: (err as Error).message, account: acct.email, query: args.query };
        }
      },
    }),

    gdrive_read: tool({
      description: 'Read the contents of a Google Doc, Sheet, or text file from Drive.',
      parameters: Z.object({
        fileId: Z.string().describe('Drive file id (from gdrive_search)'),
        account: Z.string().optional().describe("Drive owner's mailbox"),
      }),
      execute: async (args: { fileId: string; account?: string }) => {
        const acct = pickAccount(ctx, args.account);
        try {
          const result = await gogRun(['drive', 'cat', args.fileId], acct);
          if (result.exitCode !== 0) {
            return { error: result.stderr.trim(), account: acct.email, fileId: args.fileId };
          }
          const body = result.stdout;
          return {
            acct,
            fileId: args.fileId,
            contentPreview: body.slice(0, 4000),
            truncated: body.length > 4000,
            totalLength: body.length,
          };
        } catch (err) {
          return { error: (err as Error).message, account: acct.email, fileId: args.fileId };
        }
      },
    }),
  };
}
