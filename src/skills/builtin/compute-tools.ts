/**
 * Compute tools — `calculate` and `json_query`. Both fix things models get
 * wrong on their own: arithmetic (LLMs confidently miscompute) and pulling a
 * value out of a JSON blob (e.g. an `http_request` response). Pure, no I/O, no
 * secrets — safe on every channel.
 *
 * `calculate` evaluates with a real tokenizer + shunting-yard → RPN. It does
 * NOT use eval(): the input is never executed as code, only parsed against a
 * fixed grammar (numbers, + - * / % ^, parentheses, unary minus, and a small
 * set of unary functions + constants). An unknown token is a structured error.
 */

import { z } from 'zod';
import { defineTool } from '../toolkit.js';

const FUNCS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  ln: Math.log,
  log: Math.log10,
  exp: Math.exp,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };
const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3, 'u-': 4 };
const RIGHT_ASSOC = new Set(['^', 'u-']);

type Tok = { t: 'num'; v: number } | { t: 'op'; v: string } | { t: 'fn'; v: string } | { t: 'paren'; v: '(' | ')' };

function tokenize(src: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  const isOpChar = (c: string) => '+-*/%^'.includes(c);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n') {
      i++;
      continue;
    }
    if (c === '(' || c === ')') {
      tokens.push({ t: 'paren', v: c });
      i++;
      continue;
    }
    if (isOpChar(c)) {
      // Unary minus: leading, or after another operator / '('.
      const prev = tokens[tokens.length - 1];
      const unary = c === '-' && (!prev || prev.t === 'op' || (prev.t === 'paren' && prev.v === '('));
      tokens.push({ t: 'op', v: unary ? 'u-' : c });
      i++;
      continue;
    }
    const numMatch = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (numMatch) {
      tokens.push({ t: 'num', v: Number.parseFloat(numMatch[0]) });
      i += numMatch[0].length;
      continue;
    }
    const idMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(src.slice(i));
    if (idMatch) {
      const id = idMatch[0].toLowerCase();
      if (id in CONSTS) tokens.push({ t: 'num', v: CONSTS[id] });
      else if (id in FUNCS) tokens.push({ t: 'fn', v: id });
      else throw new Error(`unknown name: ${idMatch[0]}`);
      i += idMatch[0].length;
      continue;
    }
    throw new Error(`unexpected character: ${c}`);
  }
  return tokens;
}

/** Evaluate an arithmetic expression. Throws on a malformed expression. */
export function evaluateExpression(src: string): number {
  const output: Tok[] = [];
  const stack: Tok[] = [];
  for (const tok of tokenize(src)) {
    if (tok.t === 'num') output.push(tok);
    else if (tok.t === 'fn') stack.push(tok);
    else if (tok.t === 'op') {
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.t === 'fn') {
          output.push(stack.pop()!);
        } else if (
          top.t === 'op' &&
          (PREC[top.v] > PREC[tok.v] || (PREC[top.v] === PREC[tok.v] && !RIGHT_ASSOC.has(tok.v)))
        ) {
          output.push(stack.pop()!);
        } else break;
      }
      stack.push(tok);
    } else if (tok.v === '(') {
      stack.push(tok);
    } else {
      // ')'
      let matched = false;
      while (stack.length) {
        const top = stack.pop()!;
        if (top.t === 'paren' && top.v === '(') {
          matched = true;
          break;
        }
        output.push(top);
      }
      if (!matched) throw new Error('mismatched parentheses');
      if (stack[stack.length - 1]?.t === 'fn') output.push(stack.pop()!);
    }
  }
  while (stack.length) {
    const top = stack.pop()!;
    if (top.t === 'paren') throw new Error('mismatched parentheses');
    output.push(top);
  }

  const vals: number[] = [];
  for (const tok of output) {
    if (tok.t === 'num') vals.push(tok.v);
    else if (tok.t === 'fn') {
      const x = vals.pop();
      if (x === undefined) throw new Error('malformed expression');
      vals.push(FUNCS[tok.v](x));
    } else if (tok.t === 'op' && tok.v === 'u-') {
      const x = vals.pop();
      if (x === undefined) throw new Error('malformed expression');
      vals.push(-x);
    } else if (tok.t === 'op') {
      const b = vals.pop();
      const a = vals.pop();
      if (a === undefined || b === undefined) throw new Error('malformed expression');
      switch (tok.v) {
        case '+': vals.push(a + b); break;
        case '-': vals.push(a - b); break;
        case '*': vals.push(a * b); break;
        case '/': vals.push(a / b); break;
        case '%': vals.push(a % b); break;
        case '^': vals.push(a ** b); break;
      }
    }
  }
  if (vals.length !== 1) throw new Error('malformed expression');
  return vals[0];
}

/** Read a value out of a parsed object by a dot/bracket path (a.b[0].c). */
export function queryPath(root: unknown, path: string): { found: boolean; value?: unknown } {
  const segments = path.match(/[^.[\]]+|\[\d+\]/g);
  if (!segments) return { found: false };
  let cur: unknown = root;
  for (const seg of segments) {
    const idx = /^\[(\d+)\]$/.exec(seg);
    const key = idx ? Number.parseInt(idx[1], 10) : seg;
    if (cur === null || cur === undefined || typeof cur !== 'object') return { found: false };
    cur = (cur as Record<string | number, unknown>)[key];
    if (cur === undefined) return { found: false };
  }
  return { found: true, value: cur };
}

export const computeTools = {
  calculate: defineTool({
    description:
      'Evaluate an arithmetic expression and return the numeric result. Supports + - * / % ^, ' +
      'parentheses, unary minus, the constants pi/e, and the functions sqrt/abs/round/floor/ceil/' +
      'ln/log/exp/sin/cos/tan. Does NOT execute code. Use instead of doing math in your head.',
    parameters: z.object({ expression: z.string().min(1) }),
    output: z.union([
      z.object({ ok: z.literal(true), result: z.number() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
    execute: ({ expression }) => {
      try {
        const result = evaluateExpression(expression);
        if (!Number.isFinite(result)) {
          return { ok: false as const, error: 'result is not finite (e.g. division by zero)' };
        }
        return { ok: true as const, result };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    },
  }),

  json_query: defineTool({
    description:
      'Extract a value from a JSON string by a dot/bracket path (e.g. "items[0].name" or ' +
      '"data.total"). Returns the value and its JSON type. Use to pull a field out of an ' +
      'http_request response instead of eyeballing it.',
    parameters: z.object({ json: z.string(), path: z.string().min(1) }),
    output: z.union([
      z.object({ ok: z.literal(true), value: z.unknown(), type: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
    execute: ({ json, path }) => {
      let root: unknown;
      try {
        root = JSON.parse(json);
      } catch {
        return { ok: false as const, error: 'invalid JSON' };
      }
      const r = queryPath(root, path);
      if (!r.found) return { ok: false as const, error: `path not found: ${path}` };
      const type = r.value === null ? 'null' : Array.isArray(r.value) ? 'array' : typeof r.value;
      return { ok: true as const, value: r.value, type };
    },
  }),
};
