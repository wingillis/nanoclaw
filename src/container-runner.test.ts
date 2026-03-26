import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mutable config — tests can override ZAI_* fields between runs
const mockConfig = vi.hoisted(() => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  ONECLI_URL: 'http://localhost:10254',
  TIMEZONE: 'America/Los_Angeles',
  OBSIDIAN_VAULT_PATH: null as string | null,
  LLM_ROUTER_LOCAL_PROXY_PORT: 3002,
  ZAI_BASE_URL: null as string | null,
  ZAI_DEFAULT_OPUS_MODEL: null as string | null,
  ZAI_DEFAULT_SONNET_MODEL: null as string | null,
  ZAI_DEFAULT_HAIKU_MODEL: null as string | null,
}));

// Mock config
vi.mock('./config.js', () => mockConfig);

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock OneCLI SDK
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    createAgent = vi.fn().mockResolvedValue({ id: 'test' });
    ensureAgent = vi
      .fn()
      .mockResolvedValue({ name: 'test', identifier: 'test', created: true });
  },
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('Z.AI env injection', () => {
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    // Reset Z.AI config to null before each test
    mockConfig.ZAI_BASE_URL = null;
    mockConfig.ZAI_DEFAULT_OPUS_MODEL = null;
    mockConfig.ZAI_DEFAULT_SONNET_MODEL = null;
    mockConfig.ZAI_DEFAULT_HAIKU_MODEL = null;
    const cp = await import('child_process');
    spawnMock = cp.spawn as ReturnType<typeof vi.fn>;
    spawnMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runAndCapture(modelProfile?: 'local'): Promise<string[]> {
    const resultPromise = runContainerAgent(
      testGroup,
      { ...testInput, modelProfile },
      () => {},
      vi.fn(async () => {}),
    );
    // Let buildContainerArgs (async — awaits onecli mock) complete so spawn is called
    await vi.advanceTimersByTimeAsync(10);
    // Non-zero exit resolves immediately without needing output markers
    fakeProc.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
    return spawnMock.mock.calls[0]?.[1] as string[];
  }

  it('does not inject ANTHROPIC_BASE_URL when ZAI_BASE_URL is null', async () => {
    const args = await runAndCapture();
    const baseUrlArgs = args.filter(
      (a) =>
        typeof a === 'string' &&
        a.startsWith('ANTHROPIC_BASE_URL=') &&
        !a.includes('host.docker.internal'),
    );
    expect(baseUrlArgs).toHaveLength(0);
  });

  it('injects ANTHROPIC_BASE_URL when ZAI_BASE_URL is set', async () => {
    mockConfig.ZAI_BASE_URL = 'https://api.z.ai/v1';
    const args = await runAndCapture();
    expect(args).toContain('ANTHROPIC_BASE_URL=https://api.z.ai/v1');
  });

  it('injects all three model overrides when set', async () => {
    mockConfig.ZAI_DEFAULT_OPUS_MODEL = 'glm-4-plus';
    mockConfig.ZAI_DEFAULT_SONNET_MODEL = 'glm-4-air';
    mockConfig.ZAI_DEFAULT_HAIKU_MODEL = 'glm-4-flash';
    const args = await runAndCapture();
    expect(args).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=glm-4-plus');
    expect(args).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL=glm-4-air');
    expect(args).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-4-flash');
  });

  it('local profile overrides ZAI_BASE_URL with local proxy URL', async () => {
    mockConfig.ZAI_BASE_URL = 'https://api.z.ai/v1';
    const args = await runAndCapture('local');
    // Z.AI URL appears first, then overridden — only the last -e value matters to Docker
    const baseUrlValues = args.reduce<string[]>((acc, a, i) => {
      if (
        args[i - 1] === '-e' &&
        typeof a === 'string' &&
        a.startsWith('ANTHROPIC_BASE_URL=')
      )
        acc.push(a);
      return acc;
    }, []);
    // Both entries present; last one is the local proxy
    expect(baseUrlValues[0]).toBe('ANTHROPIC_BASE_URL=https://api.z.ai/v1');
    expect(baseUrlValues[baseUrlValues.length - 1]).toContain(
      'host.docker.internal',
    );
  });
});
