/**
 * GitHub skill — read repos / issues / PRs and post comments via the
 * operator's personal access token. No external deps; uses Node's
 * built-in fetch against the GitHub REST API v3.
 *
 * Vault keys:
 *   skill.github.token             — the PAT (github_pat_... or ghp_...)
 *   skill.github.default_owner     — optional fallback owner for unscoped queries
 *   skill.github.default_repo      — optional fallback repo (owner/repo) for unscoped queries
 *
 * Write surface is intentionally narrow: only `gh_issue_comment`. Pushing
 * code, merging PRs, and closing issues are NOT exposed; those are
 * destructive on a public surface and the operator does them by hand.
 */

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
  env: Record<string, string | undefined>;
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  requirePassphrase: (skillName: string, candidate?: string) => void;
  tool: (def: unknown) => unknown;
  z: {
    object: (shape: Record<string, unknown>) => unknown;
    string: () => { describe: (s: string) => unknown; optional: () => unknown; default: (v: string) => unknown };
    number: () => { default: (n: number) => { describe: (s: string) => unknown } };
    boolean: () => { default: (v: boolean) => { describe: (s: string) => unknown } };
  };
}

const GH_API = 'https://api.github.com';

function token(ctx: SkillToolContext): string {
  const t = ctx.vault.get<string>('skill.github.token');
  if (!t) {
    throw new Error('github skill not configured. run `meridian skills setup github` to set your PAT.');
  }
  return t;
}

async function gh(ctx: SkillToolContext, path: string, init: RequestInit = {}): Promise<Response> {
  const t = token(ctx);
  return fetch(`${GH_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${t}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'meridian-agent',
      ...(init.headers ?? {}),
    },
  });
}

interface RepoTarget {
  owner: string;
  repo: string;
}

function resolveRepo(ctx: SkillToolContext, override?: string): RepoTarget {
  const fallback = ctx.vault.get<string>('skill.github.default_repo');
  const candidate = override ?? fallback;
  if (!candidate) {
    throw new Error(
      'no repo specified and no default set. pass `repo: "owner/name"` or run `meridian skills setup github` to set a default.',
    );
  }
  const [owner, repo] = candidate.split('/');
  if (!owner || !repo) {
    throw new Error(`invalid repo "${candidate}", expected "owner/repo"`);
  }
  return { owner, repo };
}

interface GhIssue {
  number: number;
  title: string;
  state: string;
  user?: { login: string };
  assignee?: { login: string } | null;
  labels?: Array<{ name: string } | string>;
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request?: unknown;
  body?: string;
  comments?: number;
}

function trimBody(body: string | undefined, maxChars = 1500): string {
  if (!body) return '';
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n\n[truncated, ${body.length - maxChars} more chars]`;
}

function formatIssue(i: GhIssue): Record<string, unknown> {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    type: i.pull_request ? 'pr' : 'issue',
    author: i.user?.login,
    assignee: i.assignee?.login ?? null,
    labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    url: i.html_url,
    commentCount: i.comments,
  };
}

interface SetupCtx {
  vault: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    has(key: string): boolean;
  };
  prompt: (question: string, opts?: { mask?: boolean }) => Promise<string>;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  err: (msg: string) => void;
}

interface GhUser {
  login: string;
  name?: string | null;
  type?: string;
}

/**
 * Interactive setup walkthrough. Prompts for the PAT, validates it with
 * `GET /user`, and optionally captures a default owner/repo.
 */
export async function setup(ctx: SetupCtx): Promise<void> {
  const existing = ctx.vault.get<string>('skill.github.token');
  if (existing) {
    const replace = await ctx.prompt('A GitHub token is already stored. Replace it? [y/N]:');
    if (!/^y(es)?$/i.test(replace)) {
      ctx.log('keeping existing token. (you can still update default repo/owner below.)');
    } else {
      ctx.vault.set('skill.github.token', undefined as unknown as string);
    }
  }

  let pat = ctx.vault.get<string>('skill.github.token');
  if (!pat) {
    ctx.log('Create a fine-grained PAT at https://github.com/settings/personal-access-tokens/new');
    ctx.log('  scopes: Issues + Pull requests = read/write; Contents + Metadata = read');
    pat = await ctx.prompt('Paste your GitHub PAT:', { mask: true });
    if (!pat) {
      ctx.err('no token entered. aborting.');
      return;
    }
    if (!pat.startsWith('github_pat_') && !pat.startsWith('ghp_')) {
      ctx.warn('token does not start with "github_pat_" or "ghp_" — proceeding anyway.');
    }
  }

  ctx.log('validating with GET /user...');
  let user: GhUser;
  try {
    const res = await fetch(`${GH_API}/user`, {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'meridian-agent',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      ctx.err(`GitHub rejected the token (${res.status}). ${body.slice(0, 160)}`);
      return;
    }
    user = (await res.json()) as GhUser;
    ctx.log(`token works. authenticated as ${user.login}${user.name ? ` (${user.name})` : ''}.`);
  } catch (err) {
    ctx.err(`network error during validation: ${(err as Error).message}`);
    return;
  }

  ctx.vault.set('skill.github.token', pat);

  const currentDefaultRepo = ctx.vault.get<string>('skill.github.default_repo');
  const repoPrompt = currentDefaultRepo
    ? `Default repo for unscoped queries [${currentDefaultRepo}]:`
    : `Default repo for unscoped queries (e.g. ${user.login}/meridian, leave blank to skip):`;
  const defaultRepo = (await ctx.prompt(repoPrompt)).trim();
  if (defaultRepo) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(defaultRepo)) {
      ctx.warn(`"${defaultRepo}" is not in owner/repo form. skipping.`);
    } else {
      ctx.vault.set('skill.github.default_repo', defaultRepo);
      ctx.log(`default repo set to ${defaultRepo}.`);
    }
  } else if (currentDefaultRepo) {
    ctx.log(`keeping default repo: ${currentDefaultRepo}`);
  }

  const currentDefaultOwner = ctx.vault.get<string>('skill.github.default_owner');
  if (!currentDefaultOwner) {
    ctx.vault.set('skill.github.default_owner', user.login);
    ctx.log(`default owner set to ${user.login}.`);
  }

  ctx.log('github configured.');
}

export function createTools(ctx: SkillToolContext): Record<string, unknown> {
  const { tool, z } = ctx;
  const Z = z as unknown as {
    object: (shape: Record<string, unknown>) => unknown;
    string: () => { describe: (s: string) => unknown; optional: () => unknown; default: (v: string) => unknown };
    number: () => { default: (n: number) => { describe: (s: string) => unknown } };
    boolean: () => { default: (v: boolean) => { describe: (s: string) => unknown } };
  };

  return {
    gh_repo_summary: tool({
      description:
        'One-shot snapshot of a GitHub repo: open issue count, open PR count, latest release, ' +
        'recent activity. Best for "what is the state of <repo>" questions.',
      parameters: Z.object({
        repo: Z.string().optional().describe('owner/repo (omit to use default)'),
      }),
      execute: async (args: { repo?: string }) => {
        try {
          const t = resolveRepo(ctx, args.repo);
          const [issuesRes, prsRes, releaseRes, repoRes] = await Promise.all([
            gh(ctx, `/repos/${t.owner}/${t.repo}/issues?state=open&per_page=1`),
            gh(ctx, `/repos/${t.owner}/${t.repo}/pulls?state=open&per_page=10`),
            gh(ctx, `/repos/${t.owner}/${t.repo}/releases/latest`),
            gh(ctx, `/repos/${t.owner}/${t.repo}`),
          ]);
          const repo = repoRes.ok ? ((await repoRes.json()) as Record<string, unknown>) : null;
          const prs = prsRes.ok ? ((await prsRes.json()) as GhIssue[]) : [];
          const release = releaseRes.ok ? ((await releaseRes.json()) as Record<string, unknown>) : null;
          // Issue count from Link header pagination "last" rel; cheap.
          const link = issuesRes.headers.get('Link') ?? '';
          const lastMatch = /[?&]page=(\d+)>; rel="last"/.exec(link);
          const openIssueCount = lastMatch ? parseInt(lastMatch[1], 10) : (issuesRes.ok ? (await issuesRes.json()).length : 0);
          return {
            repo: `${t.owner}/${t.repo}`,
            description: repo?.description ?? null,
            stars: repo?.stargazers_count ?? null,
            forks: repo?.forks_count ?? null,
            defaultBranch: repo?.default_branch ?? null,
            openIssues: openIssueCount,
            openPrs: prs.length,
            recentPrs: prs.slice(0, 5).map(formatIssue),
            latestRelease: release ? {
              tag: release.tag_name,
              name: release.name,
              publishedAt: release.published_at,
              url: release.html_url,
            } : null,
            updatedAt: repo?.updated_at ?? null,
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    }),

    gh_issues_list: tool({
      description: 'List issues in a repo with filters.',
      parameters: Z.object({
        repo: Z.string().optional().describe('owner/repo (omit to use default)'),
        state: Z.string().optional().describe('"open" (default), "closed", or "all"'),
        labels: Z.string().optional().describe('Comma-separated label names'),
        assignee: Z.string().optional().describe('GitHub username (or "*" for any assignee, "none" for unassigned)'),
        since: Z.string().optional().describe('ISO 8601 timestamp; only return issues updated at or after this time'),
        maxResults: Z.number().default(20).describe('Max issues (1-100)'),
      }),
      execute: async (args: { repo?: string; state?: string; labels?: string; assignee?: string; since?: string; maxResults: number }) => {
        try {
          const t = resolveRepo(ctx, args.repo);
          const params = new URLSearchParams();
          params.set('state', args.state === 'closed' || args.state === 'all' ? args.state : 'open');
          params.set('per_page', String(Math.min(Math.max(args.maxResults, 1), 100)));
          if (args.labels) params.set('labels', args.labels);
          if (args.assignee) params.set('assignee', args.assignee);
          if (args.since) params.set('since', args.since);
          const res = await gh(ctx, `/repos/${t.owner}/${t.repo}/issues?${params.toString()}`);
          if (!res.ok) return { error: `GitHub ${res.status}: ${await res.text().catch(() => '')}` };
          const issues = (await res.json()) as GhIssue[];
          // Filter out PRs (the issues endpoint returns both)
          const onlyIssues = issues.filter((i) => !i.pull_request);
          return { repo: `${t.owner}/${t.repo}`, count: onlyIssues.length, issues: onlyIssues.map(formatIssue) };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    }),

    gh_issue_get: tool({
      description: 'Fetch a single issue or PR with its comments.',
      parameters: Z.object({
        repo: Z.string().optional().describe('owner/repo (omit to use default)'),
        number: Z.number().default(0).describe('Issue or PR number'),
        includeComments: Z.boolean().default(true).describe('Include the comment thread'),
      }),
      execute: async (args: { repo?: string; number: number; includeComments: boolean }) => {
        try {
          const t = resolveRepo(ctx, args.repo);
          const issueRes = await gh(ctx, `/repos/${t.owner}/${t.repo}/issues/${args.number}`);
          if (!issueRes.ok) return { error: `GitHub ${issueRes.status}: ${await issueRes.text().catch(() => '')}` };
          const issue = (await issueRes.json()) as GhIssue;
          let comments: Array<Record<string, unknown>> = [];
          if (args.includeComments) {
            const cRes = await gh(ctx, `/repos/${t.owner}/${t.repo}/issues/${args.number}/comments?per_page=100`);
            if (cRes.ok) {
              const raw = (await cRes.json()) as Array<{ user?: { login: string }; body: string; created_at: string; html_url: string }>;
              comments = raw.map((c) => ({
                author: c.user?.login,
                createdAt: c.created_at,
                body: trimBody(c.body),
                url: c.html_url,
              }));
            }
          }
          return {
            ...formatIssue(issue),
            body: trimBody(issue.body),
            comments,
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    }),

    gh_issue_comment: tool({
      description:
        'Post a comment on an issue or PR. The comment is posted as the operator, not as a bot. ' +
        'Returns the comment URL on success.',
      parameters: Z.object({
        repo: Z.string().optional().describe('owner/repo (omit to use default)'),
        number: Z.number().default(0).describe('Issue or PR number'),
        body: Z.string().describe('Comment body (markdown supported)'),
      }),
      execute: async (args: { repo?: string; number: number; body: string }) => {
        try {
          const t = resolveRepo(ctx, args.repo);
          const res = await gh(ctx, `/repos/${t.owner}/${t.repo}/issues/${args.number}/comments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: args.body }),
          });
          if (!res.ok) return { error: `GitHub ${res.status}: ${await res.text().catch(() => '')}` };
          const j = (await res.json()) as { id: number; html_url: string; created_at: string };
          return { commentId: j.id, url: j.html_url, postedAt: j.created_at };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    }),

    gh_prs_list: tool({
      description: 'List pull requests in a repo with filters.',
      parameters: Z.object({
        repo: Z.string().optional().describe('owner/repo (omit to use default)'),
        state: Z.string().optional().describe('"open" (default), "closed", or "all"'),
        maxResults: Z.number().default(20).describe('Max PRs (1-100)'),
      }),
      execute: async (args: { repo?: string; state?: string; maxResults: number }) => {
        try {
          const t = resolveRepo(ctx, args.repo);
          const params = new URLSearchParams();
          params.set('state', args.state === 'closed' || args.state === 'all' ? args.state : 'open');
          params.set('per_page', String(Math.min(Math.max(args.maxResults, 1), 100)));
          params.set('sort', 'updated');
          params.set('direction', 'desc');
          const res = await gh(ctx, `/repos/${t.owner}/${t.repo}/pulls?${params.toString()}`);
          if (!res.ok) return { error: `GitHub ${res.status}: ${await res.text().catch(() => '')}` };
          const prs = (await res.json()) as GhIssue[];
          return { repo: `${t.owner}/${t.repo}`, count: prs.length, prs: prs.map(formatIssue) };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    }),

    gh_pr_get: tool({
      description: 'Fetch a single pull request with diff stats and review state.',
      parameters: Z.object({
        repo: Z.string().optional().describe('owner/repo (omit to use default)'),
        number: Z.number().default(0).describe('PR number'),
      }),
      execute: async (args: { repo?: string; number: number }) => {
        try {
          const t = resolveRepo(ctx, args.repo);
          const [prRes, reviewsRes] = await Promise.all([
            gh(ctx, `/repos/${t.owner}/${t.repo}/pulls/${args.number}`),
            gh(ctx, `/repos/${t.owner}/${t.repo}/pulls/${args.number}/reviews`),
          ]);
          if (!prRes.ok) return { error: `GitHub ${prRes.status}: ${await prRes.text().catch(() => '')}` };
          const pr = (await prRes.json()) as Record<string, unknown> & GhIssue;
          const reviews = reviewsRes.ok ? ((await reviewsRes.json()) as Array<{ user?: { login: string }; state: string; submitted_at: string }>) : [];
          return {
            ...formatIssue(pr),
            body: trimBody(pr.body),
            head: (pr.head as { ref?: string })?.ref ?? null,
            base: (pr.base as { ref?: string })?.ref ?? null,
            mergeable: pr.mergeable ?? null,
            merged: pr.merged ?? null,
            additions: pr.additions ?? null,
            deletions: pr.deletions ?? null,
            changedFiles: pr.changed_files ?? null,
            reviews: reviews.map((r) => ({
              reviewer: r.user?.login,
              state: r.state,
              submittedAt: r.submitted_at,
            })),
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    }),

    gh_search_code: tool({
      description:
        'Search code across repos the operator can access. Use GitHub code-search syntax ' +
        '(e.g. "NEBUCHADNEZZAR_MAX repo:Rezzyman/cortex").',
      parameters: Z.object({
        query: Z.string().describe('GitHub code search query'),
        maxResults: Z.number().default(10).describe('Max results (1-50)'),
      }),
      execute: async (args: { query: string; maxResults: number }) => {
        try {
          const params = new URLSearchParams({
            q: args.query,
            per_page: String(Math.min(Math.max(args.maxResults, 1), 50)),
          });
          const res = await gh(ctx, `/search/code?${params.toString()}`);
          if (!res.ok) return { error: `GitHub ${res.status}: ${await res.text().catch(() => '')}` };
          const j = (await res.json()) as { total_count: number; items: Array<{ name: string; path: string; html_url: string; repository: { full_name: string } }> };
          return {
            query: args.query,
            totalCount: j.total_count,
            results: j.items.map((it) => ({
              repo: it.repository.full_name,
              path: it.path,
              name: it.name,
              url: it.html_url,
            })),
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    }),

    gh_my_open: tool({
      description:
        'Everything currently open and assigned to (or authored by) the operator across all accessible repos. ' +
        'Best for "what am I on the hook for?" type questions.',
      parameters: Z.object({
        scope: Z.string().optional().describe('"assigned" (default), "authored", or "mentioned"'),
        maxResults: Z.number().default(20).describe('Max items (1-100)'),
      }),
      execute: async (args: { scope?: string; maxResults: number }) => {
        try {
          // Resolve operator login first.
          const meRes = await gh(ctx, '/user');
          if (!meRes.ok) return { error: `GitHub ${meRes.status}: ${await meRes.text().catch(() => '')}` };
          const me = (await meRes.json()) as { login: string };
          const scope = args.scope === 'authored' ? 'author' : args.scope === 'mentioned' ? 'mentions' : 'assignee';
          const q = `is:open is:issue ${scope}:${me.login}`;
          const params = new URLSearchParams({
            q,
            per_page: String(Math.min(Math.max(args.maxResults, 1), 100)),
            sort: 'updated',
            order: 'desc',
          });
          const res = await gh(ctx, `/search/issues?${params.toString()}`);
          if (!res.ok) return { error: `GitHub ${res.status}: ${await res.text().catch(() => '')}` };
          const j = (await res.json()) as { total_count: number; items: GhIssue[] };
          return {
            scope,
            login: me.login,
            totalCount: j.total_count,
            items: j.items.map((i) => ({
              ...formatIssue(i),
              repo: /repos\/([^\/]+\/[^\/]+)\/issues/.exec(i.html_url)?.[1] ?? null,
            })),
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    }),
  };
}
