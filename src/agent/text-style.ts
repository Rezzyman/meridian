/**
 * Human texting shape (WS5b).
 *
 * The bar, in the operator's words: talking to the agent over text should
 * feel like texting a sharp person who knows the role cold, not like reading
 * a chatbot. That is partly a prompt rule and partly a delivery rule. This
 * module owns both: the rules the model reads on text channels, and the
 * shaping applied to what it wrote before it goes out as bubbles.
 */
export interface TextStylePolicy {
  enabled: boolean;
  /** Longest single bubble; longer content is split on sentence breaks. */
  maxBubbleChars: number;
  /** At most this many bubbles per reply; the remainder joins the last one. */
  maxBubbles: number;
  /** Convert markdown headers, bullets, bold, and code fences to plain text. */
  stripMarkdown: boolean;
  /** Remove "As an AI", "I'm just a language model", and similar. */
  noAssistantSpeak: boolean;
  /** Simulated composing delay per character, capped by maxDelayMs. */
  delayMsPerChar: number;
  maxDelayMs: number;
}

export const DEFAULT_TEXT_STYLE: TextStylePolicy = {
  enabled: true,
  maxBubbleChars: 500,
  maxBubbles: 4,
  stripMarkdown: true,
  noAssistantSpeak: true,
  delayMsPerChar: 8,
  maxDelayMs: 2000,
};

export const TEXT_CHANNELS: ReadonlySet<string> = new Set([
  'telegram',
  'imessage',
  'sms',
  'whatsapp',
]);

export function isTextChannel(channel: string): boolean {
  return TEXT_CHANNELS.has(channel);
}

/** Appended to the system prompt on text channels. Short on purpose. */
export const TEXT_STYLE_RULES = `<text_style>
You are texting a person. Write the way a sharp, warm human texts:
- Short. One to three sentences per message. Split a long answer into a few messages, not one wall.
- Plain text. No headers, no bullet lists, no bold, no tables. Say it in sentences.
- First person, present tense, contractions. No "As an AI", no "I'm just a", no disclaimers about being a model.
- No sign-offs, no "let me know if you need anything else", no "I hope this helps".
- If you do not have something, say so like a person would ("I don't have that one yet, want to tell me?") and ask one question.
- Match the operator's register. If they text three words, you do not text three paragraphs.
</text_style>`;

// Clause-scoped on purpose: remove the tell, keep the sentence's substance.
// "As an AI, I don't have feelings, but here's what I found: Eric wants it
// Friday." must come out as "Here's what I found: Eric wants it Friday."
const ASSISTANT_SPEAK_CLAUSES = [
  /\b(?:as|being) an? (?:ai|artificial intelligence|language model|llm|assistant|chatbot)\b[^,:;.!?\n]*[,:;]?\s*/gi,
  /\bi(?:'m| am) (?:just |only )?(?:an? )?(?:ai|artificial intelligence|language model|llm|chatbot|virtual assistant)\b[^,:;.!?\n]*[,:;.!?]?\s*/gi,
  /\bi (?:don't|do not) have (?:personal )?(?:feelings|emotions|opinions)\b[^,:;.!?\n]*[,:;.!?]?\s*/gi,
  /\b(?:but|and|so|however)\s+(?=here(?:'s| is)|i can|i found)/gi,
];
// Whole-sentence removals: these carry no information.
const SIGN_OFFS = [
  /\bi hope (?:this|that) helps\b[^.!?\n]*[.!?]?\s*/gi,
  /\blet me know if (?:you (?:need|have|want)|there(?:'s| is) anything)[^.!?\n]*[.!?]?\s*/gi,
  /\b(?:is there anything else (?:i can|you need)|feel free to (?:ask|reach out))[^.!?\n]*[.!?]?\s*/gi,
];

export function stripAssistantSpeak(text: string): string {
  let out = text;
  for (const re of ASSISTANT_SPEAK_CLAUSES) out = out.replace(re, '');
  for (const re of SIGN_OFFS) out = out.replace(re, '');
  // Capitalize a sentence that lost its opening clause.
  out = out.replace(
    /(^|[.!?]\s+)([a-z])/g,
    (_m, pre: string, c: string) => `${pre}${c.toUpperCase()}`,
  );
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function stripMarkdown(text: string): string {
  return (
    text
      // fenced code: keep the content, drop the fences
      .replace(/```[a-z]*\n?([\s\S]*?)```/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      // headers
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      // bold / italics
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,!?])/g, '$1$2')
      // bullets and numbered lists become plain lines
      .replace(/^\s*[-*•]\s+/gm, '')
      .replace(/^\s*\d+[.)]\s+/gm, '')
      // horizontal rules and table pipes
      .replace(/^\s*[-=_]{3,}\s*$/gm, '')
      .replace(/^\|.*\|\s*$/gm, (line) => line.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim())
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9"'(])/;

/** Split into bubbles: paragraphs first, then sentences, honoring the caps. */
export function shapeForText(
  reply: string,
  policy: TextStylePolicy = DEFAULT_TEXT_STYLE,
): string[] {
  let text = (reply ?? '').trim();
  if (!text) return [];
  if (!policy.enabled) return [text];
  if (policy.stripMarkdown) text = stripMarkdown(text);
  if (policy.noAssistantSpeak) text = stripAssistantSpeak(text);
  if (!text) return [];

  const units: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= policy.maxBubbleChars) {
      units.push(p);
      continue;
    }
    let current = '';
    for (const sentence of p.split(SENTENCE_END)) {
      if (current && (current + ' ' + sentence).length > policy.maxBubbleChars) {
        units.push(current);
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    }
    if (current) units.push(current);
  }
  // Hard cap for a single sentence longer than the bubble.
  const bubbles: string[] = [];
  for (const u of units) {
    let rest = u;
    while (rest.length > policy.maxBubbleChars) {
      let cut = rest.lastIndexOf(' ', policy.maxBubbleChars);
      if (cut < policy.maxBubbleChars * 0.5) cut = policy.maxBubbleChars;
      bubbles.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
    if (rest) bubbles.push(rest);
  }
  if (bubbles.length > policy.maxBubbles) {
    const head = bubbles.slice(0, policy.maxBubbles - 1);
    const tail = bubbles.slice(policy.maxBubbles - 1).join('\n\n');
    return [...head, tail];
  }
  return bubbles;
}

/** How long a person would take to type this bubble. */
export function humanDelayMs(text: string, policy: TextStylePolicy = DEFAULT_TEXT_STYLE): number {
  if (!policy.enabled) return 0;
  return Math.min(policy.maxDelayMs, Math.round(text.length * policy.delayMsPerChar));
}

export const STYLE_SAMPLES: Array<{ prompt: string; raw: string }> = [
  {
    prompt: 'what did eric say about the roof',
    raw: "## Summary\n\nAs an AI, I don't have feelings, but here's what I found:\n\n- Eric said the south slope has hail bruising.\n- He wants an estimate by Friday.\n\nI hope this helps! Let me know if you need anything else.",
  },
  {
    prompt: 'am i free at 3',
    raw: 'Yes, you are free at 3pm. You have nothing scheduled between 2:30pm and 4:00pm. **Note:** your 4pm with Ricki is still on.',
  },
  {
    prompt: 'remind me what we decided on pricing',
    raw: "I don't have that one in memory yet. Want to tell me what you decided and I'll keep it?",
  },
  {
    prompt: 'draft a reply to jeff',
    raw: 'Here is a draft:\n\n```\nHey Jeff, thanks for the leads. We will have the portal up by Thursday.\n```\n\nWant me to send it?',
  },
  {
    prompt: 'ok',
    raw: 'Got it.',
  },
];
