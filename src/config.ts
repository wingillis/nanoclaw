import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the OneCLI gateway, never exposed to containers.
// Exception: third-party service credentials (CalDAV etc.) that containers
// need directly are read here and injected as explicit -e env vars.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'OBSIDIAN_VAULT_PATH',
  'ONECLI_URL',
  'TZ',
]);
const calDavEnv = readEnvFile(['CALDAV_USERNAME', 'CALDAV_PASSWORD']);
const zaiEnv = readEnvFile([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]);
const llmRouterEnv = readEnvFile([
  'LLM_ROUTER_ENABLED',
  'LLM_ROUTER_BASE_URL',
  'LLM_ROUTER_CLASSIFIER_MODEL',
  'LLM_ROUTER_LOCAL_MODEL',
  'LLM_ROUTER_LOCAL_PROXY_PORT',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL =
  process.env.ONECLI_URL || envConfig.ONECLI_URL || 'http://localhost:10254';
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

// Obsidian vault path — mounted into containers at /workspace/obsidian when set
const rawObsidianPath =
  process.env.OBSIDIAN_VAULT_PATH || envConfig.OBSIDIAN_VAULT_PATH;
export const OBSIDIAN_VAULT_PATH = rawObsidianPath
  ? path.resolve(rawObsidianPath.replace(/^~/, HOME_DIR))
  : null;

// iCloud CalDAV credentials — injected into containers as env vars when set
export const CALDAV_USERNAME =
  process.env.CALDAV_USERNAME || calDavEnv.CALDAV_USERNAME || null;
export const CALDAV_PASSWORD =
  process.env.CALDAV_PASSWORD || calDavEnv.CALDAV_PASSWORD || null;

// LLM Router — classify and route simple requests to a local model to save API costs
export const LLM_ROUTER_ENABLED =
  (process.env.LLM_ROUTER_ENABLED ||
    llmRouterEnv.LLM_ROUTER_ENABLED ||
    'false') === 'true';
export const LLM_ROUTER_BASE_URL =
  process.env.LLM_ROUTER_BASE_URL ||
  llmRouterEnv.LLM_ROUTER_BASE_URL ||
  'http://localhost:12345';
export const LLM_ROUTER_CLASSIFIER_MODEL =
  process.env.LLM_ROUTER_CLASSIFIER_MODEL ||
  llmRouterEnv.LLM_ROUTER_CLASSIFIER_MODEL ||
  'qwen3.5-0.8b';
export const LLM_ROUTER_LOCAL_MODEL =
  process.env.LLM_ROUTER_LOCAL_MODEL ||
  llmRouterEnv.LLM_ROUTER_LOCAL_MODEL ||
  'qwen3.5-9b';
export const LLM_ROUTER_LOCAL_PROXY_PORT = parseInt(
  process.env.LLM_ROUTER_LOCAL_PROXY_PORT ||
    llmRouterEnv.LLM_ROUTER_LOCAL_PROXY_PORT ||
    '3002',
  10,
);

// Z.AI / GLM routing — non-Anthropic backend, credential injected by OneCLI
// ANTHROPIC_BASE_URL overrides where containers send API requests
// ANTHROPIC_DEFAULT_*_MODEL overrides which model names the SDK maps to
export const ZAI_BASE_URL =
  process.env.ANTHROPIC_BASE_URL || zaiEnv.ANTHROPIC_BASE_URL || null;
export const ZAI_DEFAULT_OPUS_MODEL =
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ||
  zaiEnv.ANTHROPIC_DEFAULT_OPUS_MODEL ||
  null;
export const ZAI_DEFAULT_SONNET_MODEL =
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
  zaiEnv.ANTHROPIC_DEFAULT_SONNET_MODEL ||
  null;
export const ZAI_DEFAULT_HAIKU_MODEL =
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ||
  zaiEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL ||
  null;
