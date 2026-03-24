/**
 * LLM Router — classifies incoming messages by complexity and provides a local
 * model proxy for routing simple requests away from the Anthropic API.
 *
 * Classifier: qwen3.5-0.8b via OpenAI /v1/chat/completions (structured output)
 * Local proxy: HTTP server that rewrites model names and forwards to llama-server
 */
import { createServer, Server } from 'http';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';

import {
  LLM_ROUTER_BASE_URL,
  LLM_ROUTER_CLASSIFIER_MODEL,
} from './config.js';
import { logger } from './logger.js';
import type { NewMessage } from './types.js';

export type Complexity = 'simple' | 'moderate' | 'complex';

const CLASSIFIER_SYSTEM = `Classify the user's chat message by complexity.

simple   — greetings, single-fact Q&A, arithmetic, unit conversions, translations, short summaries of provided text, quick memory lookups
moderate — multi-step reasoning, research and news lookup, analysis, comparisons, scheduling tasks
complex  — writing or reviewing code, working on a codebase, creative writing, multi-step workflows requiring many tool calls`;

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'complexity_classification',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        complexity: { type: 'string', enum: ['simple', 'moderate', 'complex'] },
      },
      required: ['complexity'],
      additionalProperties: false,
    },
  },
};

export async function classifyComplexity(
  messages: NewMessage[],
): Promise<Complexity> {
  const text = messages.map((m) => `${m.sender_name}: ${m.content}`).join('\n');

  const res = await fetch(`${LLM_ROUTER_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_ROUTER_CLASSIFIER_MODEL,
      messages: [
        { role: 'system', content: CLASSIFIER_SYSTEM },
        { role: 'user', content: text },
      ],
      max_tokens: 50,
      temperature: 0.5,
      response_format: RESPONSE_FORMAT,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) throw new Error(`Classifier HTTP ${res.status}`);

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  const parsed = JSON.parse(
    data.choices?.[0]?.message?.content || '{}',
  ) as { complexity?: string };
  const label = parsed.complexity?.toLowerCase();

  if (label === 'simple') return 'simple';
  if (label === 'moderate') return 'moderate';
  return 'complex';
}

export function startLocalModelProxy(
  port: number,
  host: string,
  localModelUrl: string,
  localModel: string,
): Promise<Server> {
  const upstream = new URL(localModelUrl);
  const isHttps = upstream.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  const syntheticModels = JSON.stringify({
    data: [
      {
        id: localModel,
        type: 'model',
        display_name: localModel,
        created_at: '2025-01-01T00:00:00Z',
      },
      {
        id: 'claude-sonnet-4-6',
        type: 'model',
        display_name: 'Claude Sonnet 4.6',
        created_at: '2025-01-01T00:00:00Z',
      },
    ],
  });

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // Intercept model listing so Claude Code's availability check passes
      if (req.url?.includes('/models') && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(syntheticModels);
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = Buffer.concat(chunks);

        // Rewrite model field so llama-swap loads the configured local model
        try {
          const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
          if (typeof parsed.model === 'string') {
            parsed.model = localModel;
            body = Buffer.from(JSON.stringify(parsed));
          }
        } catch {
          // Not JSON — forward as-is
        }

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstream.host,
            'content-length': body.length,
          };
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];
        delete headers['x-api-key'];
        delete headers['authorization'];

        logger.info(
          { method: req.method, url: req.url },
          'Local model proxy forwarding request',
        );

        const basePath = upstream.pathname.replace(/\/$/, '');
        const upstreamPath = basePath + req.url;
        const upReq = makeRequest(
          {
            hostname: upstream.hostname,
            port: upstream.port || (isHttps ? 443 : 80),
            path: upstreamPath,
            method: req.method,
            headers,
          },
          (upRes) => {
            const respChunks: Buffer[] = [];
            upRes.on('data', (c) => respChunks.push(c));
            upRes.on('end', () => {
              res.writeHead(upRes.statusCode!, upRes.headers);
              res.end(Buffer.concat(respChunks));
            });
          },
        );
        upReq.on('error', (err) => {
          logger.error({ err, url: req.url }, 'Local model proxy upstream error');
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });
        upReq.write(body);
        upReq.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, localModel }, 'Local model proxy started');
      resolve(server);
    });
    server.on('error', reject);
  });
}
