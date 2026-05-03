/**
 * Bundled skill library shipping with Meridian. All names follow the
 * agentskills.io standard so they interop with the broader open ecosystem.
 *
 * Listed in the boot panel as available-but-disabled. Operator runs
 * `/skills enable <name>` to activate any of them.
 *
 * Categories mirror common operator workflows. Names are deliberately
 * portable, not vendor-bound.
 */

export const BUNDLED_SKILL_LIBRARY: Record<string, string[]> = {
  productivity: ['google-workspace', 'linear', 'notion', 'nano-pdf', 'ocr-and-documents'],
  'note-taking': ['obsidian'],
  email: ['himalaya'],
  apple: ['apple-notes', 'apple-reminders', 'findmy', 'imessage'],
  github: [
    'codebase-inspection',
    'github-auth',
    'github-code-review',
    'github-issues',
    'github-pr-workflow',
    'github-repo-management',
  ],
  research: ['arxiv', 'blogwatcher', 'llm-wiki', 'polymarket', 'research-paper-writing'],
  creative: ['ascii-art', 'ascii-video', 'excalidraw', 'manim-video', 'p5js', 'popular-web-designs'],
  media: ['gif-search', 'songsee', 'songwriting', 'youtube-content'],
  'data-science': ['jupyter-live-kernel'],
  'coding-agents': ['claude-code', 'codex', 'opencode'],
  mcp: ['mcporter', 'native-mcp'],
  'social-media': ['xitter'],
  'software-development': [
    'plan',
    'requesting-code-review',
    'subagent-driven-development',
    'systematic-debugging',
    'test-driven-development',
    'writing-plans',
  ],
  'smart-home': ['openhue'],
  leisure: ['find-nearby'],
  general: ['dogfood'],
  devops: ['webhook-subscriptions'],
  mlops: [
    'audiocraft',
    'axolotl',
    'clip',
    'dspy',
    'evaluating-llms-harness',
    'fine-tuning-with-trl',
    'gguf-quantization',
    'grpo-rl-training',
    'guidance',
    'huggingface-hub',
    'llama-cpp',
    'modal-serverless-gpu',
    'outlines',
    'peft-fine-tuning',
    'pytorch-fsdp',
    'segment-anything',
    'serving-llms-vllm',
    'stable-diffusion',
    'unsloth',
    'weights-and-biases',
    'whisper',
    'heartmula',
  ],
  gaming: ['minecraft-modpack-server', 'pokemon-player'],
};

export function librarySkillCount(): number {
  return Object.values(BUNDLED_SKILL_LIBRARY).reduce((n, arr) => n + arr.length, 0);
}
