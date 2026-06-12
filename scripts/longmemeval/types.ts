/**
 * LongMemEval dataset + harness types.
 *
 * LongMemEval (Wu et al.) measures long-term memory in chat assistants: each
 * instance buries the answer to a question inside a large "haystack" of prior
 * chat sessions, then asks the question much later. A memory system passes only
 * if it RECALLS the right evidence across sessions and the model answers from
 * it. This is the accuracy axis (complementary to MemPoisonBench's security
 * axis): MERIDIAN runs its MemoryProvider — embedded, CORTEX, or the paid
 * Quartz — through the identical harness so the comparison is apples-to-apples.
 *
 * Dataset schema mirrors the public `longmemeval_*.json` files (oracle / s / m).
 * We do not vendor the dataset (it is large and separately licensed); the
 * harness loads it from a path the operator provides.
 */

export type LongMemEvalQuestionType =
  | 'single-session-user'
  | 'single-session-assistant'
  | 'single-session-preference'
  | 'temporal-reasoning'
  | 'knowledge-update'
  | 'multi-session'
  | 'single-session-abstention'
  | string; // forward-compatible with new question types

export interface LongMemEvalTurn {
  role: 'user' | 'assistant';
  content: string;
  /** Some variants mark which turns actually contain the answer evidence. */
  has_answer?: boolean;
}

/** A haystack session = an ordered list of turns, with a date. */
export type LongMemEvalSession = LongMemEvalTurn[];

export interface LongMemEvalInstance {
  question_id: string;
  question_type: LongMemEvalQuestionType;
  question: string;
  answer: string;
  /** ISO date the question is asked (anchors temporal-reasoning questions). */
  question_date?: string;
  /** The buried sessions, oldest→newest. */
  haystack_sessions: LongMemEvalSession[];
  /** Parallel to haystack_sessions: the date of each session. */
  haystack_dates?: string[];
  /** Parallel to haystack_sessions: a stable id per session. */
  haystack_session_ids?: string[];
  /** Which sessions actually contain the answer (for diagnostics, not scoring). */
  answer_session_ids?: string[];
}

export interface InstanceResult {
  question_id: string;
  question_type: LongMemEvalQuestionType;
  question: string;
  goldAnswer: string;
  predictedAnswer: string;
  correct: boolean;
  /** How correctness was decided: 'judge' (model) or 'offline' (lexical). */
  scoredBy: 'judge' | 'offline';
  /** Whether the question is an abstention type (gold = "no information"). */
  isAbstention: boolean;
  recallTokens: number;
  ingestedTurns: number;
  /** Set when the instance failed to run (e.g. provider error). */
  error?: string;
}

export interface RunSummary {
  dataset: string;
  provider: string;
  model: string;
  scoredBy: 'judge' | 'offline';
  total: number;
  correct: number;
  accuracy: number;
  byType: Record<string, { total: number; correct: number; accuracy: number }>;
  abstention: { total: number; correct: number; accuracy: number };
  results: InstanceResult[];
}
