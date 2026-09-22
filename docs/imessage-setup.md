# iMessage setup (BlueBubbles relay)

Meridian talks over iMessage through a BlueBubbles relay: a small server that runs on a Mac signed into Messages. The agent sends blue bubbles with a typing indicator, receives texts and attachments, and can react with tapbacks. SMS stays as the fallback for people who are not on iMessage or when the relay is down.

## What you need

1. A Mac that stays on. It can be a spare Mac, a Mac mini in a closet, or a hosted Mac. It is now production infrastructure: if it sleeps, the agent goes quiet on iMessage.
2. A dedicated Apple ID and phone number for the agent. Never sign the relay Mac's Messages into a person's own Apple ID.
3. BlueBubbles Server installed on that Mac (bluebubbles.app). Note the server password and the port (default 1234).
4. A way for the gateway to reach the relay: the relay on the same network as the gateway, a WireGuard or SSH tunnel, or BlueBubbles' own tunnel (Cloudflare or ngrok). Only the gateway host needs to reach it.
5. A way for the relay to reach the gateway: the gateway's public webhook URL, the same one Telegram or Twilio would use.

## Configure the agent

In the agent's `.env`:

```dotenv
BLUEBUBBLES_URL=http://127.0.0.1:1234
BLUEBUBBLES_PASSWORD=<the server password>
BLUEBUBBLES_WEBHOOK_SECRET=<at least 16 random characters>
# optional: private-api (default, needs the BlueBubbles helper bundle) or apple-script
BLUEBUBBLES_SEND_METHOD=private-api
```

In `config.yaml`, tell the agent who the operator is on iMessage and, if you want a hard allowlist, who may text it at all:

```yaml
operator:
  channels:
    imessage: ["+13035551234"]        # the operator's handle: phone or email
channels:
  imessage:
    enabled: true
    allowedHandles: []                 # empty = anyone can reach the turn; strangers get the untrusted path
```

## Point the relay at the gateway

In BlueBubbles Server, add a webhook:

```
https://<your gateway host>/imessage/webhook?secret=<the same secret>
```

Events: New Messages. The gateway rejects any webhook without the secret.

## Check it

```
meridian doctor        # shows a BlueBubbles relay row
meridian status        # /health carries channels.imessage.relay
```

Then text the agent from the operator's handle. The reply arrives as blue bubbles. If the relay is down, `channels.imessage` on `/health` says so, and replies to phone handles fall back to SMS when Twilio is configured.

## What stays true

- The agent's handle is the agent's, not a person's.
- Slash commands from the operator's handle work here like they do on Telegram: `/approve`, `/reject`, `/drafts`, `/automations`.
- Attachments land in the agent's media folder under the same size cap as Telegram media.
- Nothing about the relay changes the agent's memory, identity, or the other channels.
