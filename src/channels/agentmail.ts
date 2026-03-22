import fs from 'fs';
import path from 'path';

import { AgentMailClient } from 'agentmail';

import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const STATE_FILE = path.join(DATA_DIR, 'agentmail.json');
const DEFAULT_POLL_INTERVAL = 30000;

interface AgentMailState {
  inboxId: string;
  email: string;
}

function loadState(): AgentMailState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as AgentMailState;
  } catch {
    return null;
  }
}

function saveState(state: AgentMailState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Parse an email address string. Handles both:
 *   "Display Name <user@example.com>"  and  "user@example.com"
 */
function parseFrom(from: string): { name: string; email: string } {
  const match = from.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].trim(), email: match[2].trim() };
  }
  return { name: from, email: from };
}

export class AgentMailChannel implements Channel {
  name = 'agentmail';

  private client: AgentMailClient;
  private inboxId: string;
  private inboxEmail: string;
  private opts: ChannelOpts;
  private connected = false;
  private seenIds = new Set<string>();
  private lastPollTime = new Date();
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInterval: number;

  /**
   * Maps chatJid → most recent inbound messageId.
   * Used by sendMessage() to reply to the correct email thread.
   * AGENTMAIL_API_KEY stays on the host — no credentials pass to containers.
   */
  private pendingReplyId = new Map<string, string>();

  constructor(
    apiKey: string,
    inboxId: string,
    inboxEmail: string,
    opts: ChannelOpts,
    pollInterval = DEFAULT_POLL_INTERVAL,
  ) {
    this.client = new AgentMailClient({ apiKey });
    this.inboxId = inboxId;
    this.inboxEmail = inboxEmail;
    this.opts = opts;
    this.pollInterval = pollInterval;
  }

  async connect(): Promise<void> {
    // Resolve inbox: by ID, by email address, or create new
    if (this.inboxId) {
      const inbox = await this.client.inboxes.get(this.inboxId);
      this.inboxEmail = inbox.email;
    } else if (this.inboxEmail) {
      // Look up inbox by email address
      const result = await this.client.inboxes.list();
      const found = result.inboxes.find((i) => i.email === this.inboxEmail);
      if (!found) {
        throw new Error(`AgentMail inbox not found for email: ${this.inboxEmail}`);
      }
      this.inboxId = found.inboxId;
      saveState({ inboxId: this.inboxId, email: this.inboxEmail });
    } else {
      // Auto-create an inbox
      const inbox = await this.client.inboxes.create({ displayName: 'NanoClaw' });
      this.inboxId = inbox.inboxId;
      this.inboxEmail = inbox.email;
      saveState({ inboxId: this.inboxId, email: this.inboxEmail });
      logger.info({ inboxId: this.inboxId, email: this.inboxEmail }, 'AgentMail: inbox created');
    }

    // Seed seenIds with existing messages so we don't replay history on startup
    this.lastPollTime = new Date();
    try {
      const result = await this.client.inboxes.messages.list(this.inboxId, { limit: 100 });
      for (const msg of result.messages) {
        this.seenIds.add(msg.messageId);
      }
      logger.debug({ count: this.seenIds.size }, 'AgentMail: seeded seen message IDs');
    } catch (err) {
      logger.warn({ err }, 'AgentMail: failed to seed seen IDs');
    }

    this.connected = true;
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => logger.error({ err }, 'AgentMail poll error'));
    }, this.pollInterval);

    logger.info({ inboxId: this.inboxId, email: this.inboxEmail }, 'AgentMail channel connected');
    console.log(`\n  AgentMail inbox: ${this.inboxEmail}`);
    console.log(`  Forward emails here for agents to respond`);
    if (!process.env.AGENTMAIL_INBOX_ID) {
      console.log(`  Tip: set AGENTMAIL_INBOX_ID=${this.inboxId} in .env to persist`);
    }
    console.log('');
  }

  private async poll(): Promise<void> {
    const pollStart = new Date();

    const result = await this.client.inboxes.messages.list(this.inboxId, {
      after: this.lastPollTime,
      ascending: true,
    });

    // Advance timestamp before processing so any messages arriving during
    // delivery are caught on the next poll
    this.lastPollTime = pollStart;

    for (const item of result.messages) {
      if (this.seenIds.has(item.messageId)) continue;
      this.seenIds.add(item.messageId);

      const chatJid = `em:${this.inboxId}`;
      const timestamp = item.timestamp.toISOString();
      const { name: fromName, email: from } = parseFrom(item.from);
      const subject = item.subject ?? '(no subject)';
      const threadId = item.threadId;

      // Report metadata for chat discovery
      this.opts.onChatMetadata(chatJid, timestamp, 'AgentMail Inbox', 'agentmail', false);

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, from },
          'Email from unregistered AgentMail inbox (register it first)',
        );
        continue;
      }

      // Fetch full message to get body (list only returns preview)
      let body = item.preview ?? '';
      try {
        const full = await this.client.inboxes.messages.get(this.inboxId, item.messageId);
        body = full.extractedText ?? full.text ?? body;
      } catch (err) {
        logger.warn({ err, messageId: item.messageId }, 'AgentMail: could not fetch message body');
      }

      // Track the latest inbound message ID so sendMessage() can reply correctly.
      // AGENTMAIL_API_KEY stays on the host — same security model as Telegram/Discord.
      this.pendingReplyId.set(chatJid, item.messageId);

      const content = [
        `[Email from: ${fromName} <${from}>]`,
        `[Subject: ${subject}]`,
        `[Thread: ${threadId}]`,
        '',
        body,
      ].join('\n');

      this.opts.onMessage(chatJid, {
        id: item.messageId,
        chat_jid: chatJid,
        sender: from,
        sender_name: fromName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info({ from, subject, threadId }, 'AgentMail email received');
    }
  }

  /**
   * Reply to the most recent inbound email in this chat.
   * API key never leaves the host — same security model as Telegram/Discord.
   */
  async sendMessage(jid: string, text: string): Promise<void> {
    const messageId = this.pendingReplyId.get(jid);
    if (!messageId) {
      logger.warn({ jid }, 'AgentMail: no pending message ID to reply to');
      return;
    }

    try {
      await this.client.inboxes.messages.reply(this.inboxId, messageId, { text });
      logger.info({ jid, messageId }, 'AgentMail reply sent');
    } catch (err) {
      logger.error({ jid, messageId, err }, 'AgentMail: failed to send reply');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('em:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
    logger.info('AgentMail channel disconnected');
  }
}

registerChannel('agentmail', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'AGENTMAIL_API_KEY',
    'AGENTMAIL_INBOX_ID',
    'AGENTMAIL_INBOX_EMAIL',
    'AGENTMAIL_POLL_INTERVAL',
  ]);
  const apiKey = process.env.AGENTMAIL_API_KEY || envVars.AGENTMAIL_API_KEY || '';
  if (!apiKey) {
    logger.debug('AgentMail: AGENTMAIL_API_KEY not set, skipping');
    return null;
  }

  // Inbox resolution priority: inbox ID → email address → persisted state → auto-create
  let inboxId = process.env.AGENTMAIL_INBOX_ID || envVars.AGENTMAIL_INBOX_ID || '';
  let inboxEmail = process.env.AGENTMAIL_INBOX_EMAIL || envVars.AGENTMAIL_INBOX_EMAIL || '';
  if (!inboxId && !inboxEmail) {
    const state = loadState();
    if (state) {
      inboxId = state.inboxId;
      inboxEmail = state.email;
    }
  }

  const pollInterval = parseInt(
    process.env.AGENTMAIL_POLL_INTERVAL || envVars.AGENTMAIL_POLL_INTERVAL || '30000',
    10,
  );

  return new AgentMailChannel(apiKey, inboxId, inboxEmail, opts, pollInterval);
});
