/**
 * Regression test for a silent bug: loadAgentEnv() builds a typed AgentEnv from
 * an explicit candidate map, and the gateway gates each channel on env.<KEY>.
 * The channel keys were missing from that map, so Slack/Discord/WhatsApp/Matrix
 * never received their config even when set. This pins them in place.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { resolveHome } from '../../src/config/home.js';
import { loadAgentEnv } from '../../src/config/loader.js';

describe('loadAgentEnv — channel env propagation', () => {
  it('copies webhook + client channel keys out of process.env', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mh-'));
    const saved = { ...process.env };
    Object.assign(process.env, {
      MERIDIAN_HOME: tmp,
      MERIDIAN_MEMORY_PROVIDER: 'embedded', // skip the Neon/Voyage triad requirement
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_SIGNING_SECRET: 'ss-test',
      DISCORD_PUBLIC_KEY: 'dpk-test',
      DISCORD_APPLICATION_ID: 'dai-test',
      WHATSAPP_PHONE_NUMBER_ID: 'wpn-test',
      WHATSAPP_ACCESS_TOKEN: 'wat-test',
      WHATSAPP_APP_SECRET: 'was-test',
      WHATSAPP_VERIFY_TOKEN: 'wvt-test',
      MATRIX_HOMESERVER_URL: 'https://hs.example',
      MATRIX_ACCESS_TOKEN: 'mat-test',
      MATRIX_USER_ID: '@bot:hs.example',
    });
    try {
      const env = loadAgentEnv(resolveHome('envtest'));
      assert.equal(env.SLACK_BOT_TOKEN, 'xoxb-test');
      assert.equal(env.SLACK_SIGNING_SECRET, 'ss-test');
      assert.equal(env.DISCORD_PUBLIC_KEY, 'dpk-test');
      assert.equal(env.DISCORD_APPLICATION_ID, 'dai-test');
      assert.equal(env.WHATSAPP_PHONE_NUMBER_ID, 'wpn-test');
      assert.equal(env.WHATSAPP_ACCESS_TOKEN, 'wat-test');
      assert.equal(env.WHATSAPP_APP_SECRET, 'was-test');
      assert.equal(env.WHATSAPP_VERIFY_TOKEN, 'wvt-test');
      assert.equal(env.MATRIX_HOMESERVER_URL, 'https://hs.example');
      assert.equal(env.MATRIX_ACCESS_TOKEN, 'mat-test');
      assert.equal(env.MATRIX_USER_ID, '@bot:hs.example');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
