/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ]);

  // ANTHROPIC_AUTH_TOKEN is used by some providers (e.g. z.ai) as an API key.
  // Treat it as an API key when ANTHROPIC_API_KEY is not set.
  const apiKey = secrets.ANTHROPIC_API_KEY || secrets.ANTHROPIC_AUTH_TOKEN;
  const authMode: AuthMode = apiKey ? 'api-key' : 'oauth';
  const oauthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  // Synthetic model list: Claude Code checks /v1/models to validate model
  // availability. Custom API providers (e.g. z.ai) don't list Claude model
  // names, so the check fails before any real request is made. Intercept
  // /v1/models and return a fake list with standard Claude names so validation
  // passes. Actual requests still have model names rewritten (see below).
  const syntheticModels = JSON.stringify({
    data: [
      {
        id: 'claude-opus-4-6',
        type: 'model',
        display_name: 'Claude Opus 4.6',
        created_at: '2025-01-01T00:00:00Z',
      },
      {
        id: 'claude-sonnet-4-6',
        type: 'model',
        display_name: 'Claude Sonnet 4.6',
        created_at: '2025-01-01T00:00:00Z',
      },
      {
        id: 'claude-haiku-4-5',
        type: 'model',
        display_name: 'Claude Haiku 4.5',
        created_at: '2025-01-01T00:00:00Z',
      },
      {
        id: 'claude-opus-4-5',
        type: 'model',
        display_name: 'Claude Opus 4.5',
        created_at: '2025-01-01T00:00:00Z',
      },
      {
        id: 'claude-sonnet-4-5',
        type: 'model',
        display_name: 'Claude Sonnet 4.5',
        created_at: '2025-01-01T00:00:00Z',
      },
    ],
  });

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // Intercept model listing — return synthetic list so Claude Code's
      // availability check always passes regardless of what the upstream supports.
      if (req.url?.includes('/models') && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(syntheticModels);
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = Buffer.concat(chunks);

        // Rewrite model name in request body so Claude Code's standard model
        // names (e.g. claude-sonnet-4-6) are transparently replaced with the
        // configured provider model names (e.g. glm-5-turbo) before forwarding.
        const opusOverride = secrets.ANTHROPIC_DEFAULT_OPUS_MODEL;
        const sonnetOverride = secrets.ANTHROPIC_DEFAULT_SONNET_MODEL;
        const haikuOverride = secrets.ANTHROPIC_DEFAULT_HAIKU_MODEL;
        if (opusOverride || sonnetOverride || haikuOverride) {
          try {
            const parsed = JSON.parse(body.toString());
            if (parsed && typeof parsed.model === 'string') {
              const m = parsed.model.toLowerCase();
              let target: string | undefined;
              if (m.includes('opus') && opusOverride) target = opusOverride;
              else if (m.includes('haiku') && haikuOverride)
                target = haikuOverride;
              else if (sonnetOverride) target = sonnetOverride;
              if (target && target !== parsed.model) {
                parsed.model = target;
                body = Buffer.from(JSON.stringify(parsed));
              }
            }
          } catch {
            // Not JSON or no model field — forward as-is
          }
        }

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = apiKey;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        logger.info(
          {
            method: req.method,
            url: req.url,
            authMode,
            bodySnippet: body.toString().slice(0, 200),
          },
          'Credential proxy forwarding request',
        );

        // Prepend upstream base path (e.g. /api/anthropic from ANTHROPIC_BASE_URL)
        const basePath = upstreamUrl.pathname.replace(/\/$/, '');
        const upstreamPath = basePath + req.url;

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: upstreamPath,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            const respChunks: Buffer[] = [];
            upRes.on('data', (c) => respChunks.push(c));
            upRes.on('end', () => {
              const respBody = Buffer.concat(respChunks);
              logger.info(
                {
                  status: upRes.statusCode,
                  url: upstreamPath,
                  responseSnippet: respBody.toString().slice(0, 300),
                },
                'Credential proxy upstream response',
              );
              res.writeHead(upRes.statusCode!, upRes.headers);
              res.end(respBody);
            });
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
  return secrets.ANTHROPIC_API_KEY || secrets.ANTHROPIC_AUTH_TOKEN
    ? 'api-key'
    : 'oauth';
}
