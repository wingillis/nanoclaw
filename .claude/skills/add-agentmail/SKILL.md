---
name: add-agentmail
description: Add AgentMail email channel to NanoClaw. Polls an agentmail.to inbox for incoming emails and auto-replies via the host process. API key never enters containers — same security model as Telegram/Discord.
---

# Add AgentMail Email Channel

This skill adds an [AgentMail](https://agentmail.to) inbox to NanoClaw. Agents receive emails as messages and reply via the host process — the API key never enters containers, following the same security model as Telegram and Discord.

## Phase 1: Pre-flight

### Check if already applied

If `src/channels/agentmail.ts` exists, skip to Phase 3 (Setup).

### Check AgentMail account

Ask the user:

> Do you have an AgentMail account and API key?

If not, direct them to https://console.agentmail.to to sign up (free tier: 3 inboxes, 3,000 emails/month).

## Phase 2: Apply Code Changes

### Merge the skill branch

The code is on the `skill/agentmail` branch of this repo:

```bash
git merge skill/agentmail
```

If merge conflicts occur, resolve them by reading both sides. The skill adds:
- `src/channels/agentmail.ts` — AgentMailChannel class with self-registration
- `import './agentmail.js'` added to `src/channels/index.ts`
- `agentmail` npm dependency in `package.json`
- `AGENTMAIL_API_KEY` env var passthrough in `src/container-runner.ts`
- `agentmail-mcp` MCP server + `mcp__agentmail__*` allowed tool in `container/agent-runner/src/index.ts`

### Install dependencies and build

```bash
npm install
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Add API key to .env

Tell the user:

> Please add your AgentMail API key to `.env`:
>
> ```
> AGENTMAIL_API_KEY=your_key_here
> ```
>
> You can find your API key at https://console.agentmail.to

Write the key to `.env`:

```bash
# Append to .env (or ask the user to do it)
echo "AGENTMAIL_API_KEY=<key>" >> .env
```

### Register the agentmail group

The channel uses a single chat JID for the inbox: `em:{inbox_id}`. The user needs to register this group. Since the inbox ID is auto-created on first startup, we need to:

1. Start NanoClaw briefly to create the inbox and print its ID:

```bash
npm run dev
```

Watch for output like:
```
  AgentMail inbox: andy@agentmail.to
  Tip: set AGENTMAIL_INBOX_ID=inbox_abc123 in .env to persist
```

2. Copy the inbox ID and add it to `.env`:
```
AGENTMAIL_INBOX_ID=inbox_abc123
```

3. Register the group via the main channel (e.g., Telegram or Discord):
```
@Andy register group em:inbox_abc123 as agentmail
```

The group folder will be created at `groups/agentmail/`. Add instructions to `groups/agentmail/CLAUDE.md` if desired.

### Clear stale agent-runner copies and rebuild

```bash
rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
cd container && ./build.sh && cd ..
```

### Restart NanoClaw

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test email receipt

Tell the user:

> Forward a test email to your AgentMail address. Within 30 seconds, NanoClaw should pick it up and the agent should reply.

Monitor logs:
```bash
tail -f logs/nanoclaw.log | grep -iE "(agentmail|email)"
```

### Check AgentMail console

Visit https://console.agentmail.to to confirm the reply was sent.

## Troubleshooting

### Channel not connecting
- Check `AGENTMAIL_API_KEY` is set in `.env`
- Verify API key at https://console.agentmail.to

### Emails not triggering the agent
- Confirm the group is registered: `@Andy list groups`
- Check `groups/agentmail/` exists
- Verify the JID matches: `em:{your_inbox_id}`

### Agent not replying to emails
- Ensure `agentmail-mcp` is available: `npx -y agentmail-mcp --help`
- Check container logs: `cat groups/agentmail/logs/container-*.log | tail -50`
- Verify `AGENTMAIL_API_KEY` is passed to containers (check container-runner logs)

## Removal

1. Delete `src/channels/agentmail.ts`
2. Remove `import './agentmail.js'` from `src/channels/index.ts`
3. Remove `AGENTMAIL_API_KEY` env passthrough from `src/container-runner.ts`
4. Remove `agentmail` MCP server and `mcp__agentmail__*` from `container/agent-runner/src/index.ts`
5. Uninstall: `npm uninstall agentmail`
6. Clear stale agent-runner copies: `rm -r data/sessions/*/agent-runner-src 2>/dev/null || true`
7. Rebuild and restart
