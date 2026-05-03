/**
 * CLI channel: stdin/stdout REPL. Used by `meridian chat`.
 */

import readline from 'node:readline';
import type { ChannelAdapter, ChannelStartOptions, InboundMessage } from './types.js';
import { colors } from '../utils/truecolor.js';

export class CLIChannel implements ChannelAdapter {
  readonly name = 'cli';
  private rl: readline.Interface | null = null;

  async start(_c: unknown, opts: ChannelStartOptions): Promise<void> {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const prompt = `${colors.cyan('❯')} `;

    const ask = () => {
      this.rl?.question(prompt, async (line) => {
        const text = line.trim();
        if (!text) {
          ask();
          return;
        }
        if (text === '/quit' || text === '/exit' || text === '/q') {
          this.rl?.close();
          return;
        }
        try {
          const msg: InboundMessage = { channel: 'cli', from: 'local', text };
          const reply = await opts.onInbound(msg);
          process.stdout.write(`${reply}\n\n`);
        } catch (err) {
          process.stdout.write(colors.err(`error: ${(err as Error).message}\n\n`));
        }
        ask();
      });
    };
    ask();
    await new Promise<void>((resolve) => this.rl?.once('close', resolve));
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = null;
  }
}
