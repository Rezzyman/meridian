/**
 * Narration guard for scheduled automations (defect (b), July 2026).
 *
 * The automation runner intermittently delivered its own step narration
 * ("I'll recall the last week... Now I'll check the calendar...") into the
 * operator's Telegram brief. The rule below is appended to every automation
 * system prompt, and `stripNarration` removes any leading planning lines that
 * slip through, so the first character delivered is the first character of
 * the message.
 */
export const NARRATION_RULE = [
  'Output ONLY the finished message text. Do not narrate your process, your',
  'tools, or your plan. Do not begin with "I\'ll", "Let me", "First,", "Now I",',
  'or a description of what you are about to do. Your first character is the',
  'first character of the message the operator reads.',
].join(' ');

const PLANNING_LINE =
  /^\s*(?:[-*]\s*)?(?:i(?:'| wi)ll\b|let me\b|first,?\s|now i(?:'ll| will)?\b|next,?\s+i\b|i am going to\b|i'm going to\b|recalling\b|checking\b|looking (?:up|at|into)\b|pulling\b|scanning\b|searching\b|reviewing\b|gathering\b|running\b|i need to\b|i should\b|to (?:do|answer|compose) (?:this|that)\b)/i;

/**
 * Drop leading lines that read as process narration. Stops at the first line
 * that reads as content. Never touches the body once content has started.
 */
export function stripNarration(text: string): string {
  if (!text) return text;
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    if (PLANNING_LINE.test(line)) {
      i += 1;
      continue;
    }
    break;
  }
  if (i === 0) return text;
  if (i >= lines.length) return text.trim(); // everything looked like narration: keep it, better than silence
  return lines.slice(i).join('\n').replace(/^\s+/, '');
}
