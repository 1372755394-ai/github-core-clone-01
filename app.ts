// HTTP server: routing, auth, body reading, JSON envelope.
// main.ts owns the lifecycle (bind 0, register, poll /done); this file owns the forge.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { handleRest } from './src/rest.ts';
import { executeGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import {
  handleReceivePack,
  handleUploadPackV0,
  handleUploadPackV2,
  receivePackAdvertisementV0,
  uploadPackAdvertisementV0,
  uploadPackAdvertisementV2,
} from './src/gitproto.ts';

const MAX_BODY_BYTES = 256 * 1024 * 1024;

export function createApp(): Server {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      try {
        sendJson(response, 500, { message: error instanceof Error ? error.message : 'internal server error' });
      } catch {
        // The socket is gone; nothing left to do.
      }
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = `req-${++requestCounter}`;
    response.setHeader('x-github-request-id', requestId);
    const rawUrl = request.url ?? '/';
    const qIndex = rawUrl.indexOf('?');
    const pathname = qIndex < 0 ? rawUrl : rawUrl.slice(0, qIndex);
    const search = qIndex < 0 ? '' : rawUrl.slice(qIndex + 1);
    const method = request.method ?? 'GET';

    if (method === 'GET' && pathname === '/healthz') {
      sendJson(response, 200, { ok: true });
      return;
    }

    // Auth: every other route needs the shop token (when the env sets one).
    if (expectedToken !== '') {
      const header = request.headers.authorization ?? '';
      if (header !== `Bearer ${expectedToken}`) {
        sendJson(response, 401, { message: 'Unauthorized' });
        return;
      }
    }

    // Most requests carry no body: skip the stream read entirely then.
    const contentLength = Number.parseInt(request.headers['content-length'] ?? '', 10);
    const hasBody = (Number.isFinite(contentLength) && contentLength > 0) || request.headers['transfer-encoding'] !== undefined;
    const body = hasBody ? await readBody(request, response) : Buffer.alloc(0);
    if (body === null) return; // readBody already answered (413 or socket error)

    try {
      if (pathname === '/api/graphql' || pathname.startsWith('/api/v3')) {
        if (pathname === '/api/graphql') {
          handleGraphQL(body, response);
          return;
        }
        const restPath = pathname.slice('/api/v3'.length) || '/';
        const result = handleRest(store, {
          method,
          pathname: restPath,
          query: new URLSearchParams(search),
          bodyText: body.toString('utf8'),
          host: request.headers.host ?? 'entry.invalid',
        });
        send(response, result.status, result.body, result.headers['content-type'] ?? 'application/json; charset=utf-8', result.headers);
        return;
      }

      if (pathname === '/mcp') {
        if (method !== 'POST') {
          sendJson(response, 405, { message: 'Method Not Allowed' });
          return;
        }
        const outcome = handleMcp(store, body.toString('utf8'));
        if (outcome.status === 202) {
          response.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
          response.end();
          return;
        }
        send(response, outcome.status, outcome.body, 'application/json; charset=utf-8');
        return;
      }

      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
      if (gitMatch) {
        handleGit(gitMatch, request, response, body, search);
        return;
      }

      sendJson(response, 404, { message: 'Not Found' });
    } catch (error) {
      sendJson(response, 500, { message: error instanceof Error ? error.message : 'internal server error' });
    }
  }

  function handleGraphQL(body: Buffer, response: ServerResponse): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(response, 400, { errors: [{ message: 'request body is not valid JSON' }] });
      return;
    }
    const operations = Array.isArray(parsed) ? parsed : [parsed];
    const results = operations.map((operation) => {
      if (operation === null || typeof operation !== 'object') {
        return { data: null, errors: [{ message: 'operation must be an object' }] };
      }
      const record = operation as Record<string, unknown>;
      const query = typeof record.query === 'string' ? record.query : '';
      const variables = (record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables) ? record.variables : {}) as Record<string, unknown>;
      return executeGraphQL(store, query, variables);
    });
    sendJson(response, 200, Array.isArray(parsed) ? results : results[0]);
  }

  function handleGit(
    gitMatch: RegExpExecArray,
    request: IncomingMessage,
    response: ServerResponse,
    body: Buffer,
    search: string,
  ): void {
    const owner = decodeURIComponent(gitMatch[1]!);
    const repoName = decodeURIComponent(gitMatch[2]!);
    const service = gitMatch[3]!;
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      sendJson(response, 404, { message: 'Not Found' });
      return;
    }
    const method = request.method ?? 'GET';
    const gitProtocol = request.headers['git-protocol'] === 'version=2' ? 2 : 0;

    if (service === 'info/refs' && method === 'GET') {
      const serviceParam = new URLSearchParams(search).get('service') ?? '';
      if (serviceParam === 'git-upload-pack') {
        const advertisement = gitProtocol === 2 ? uploadPackAdvertisementV2() : uploadPackAdvertisementV0(repo);
        send(response, 200, advertisement, 'application/x-git-upload-pack-advertisement');
        return;
      }
      if (serviceParam === 'git-receive-pack') {
        send(response, 200, receivePackAdvertisementV0(repo), 'application/x-git-receive-pack-advertisement');
        return;
      }
      sendJson(response, 400, { message: 'unknown service' });
      return;
    }

    if (service === 'git-upload-pack' && method === 'POST') {
      try {
        const out = gitProtocol === 2 ? handleUploadPackV2(store, repo, body) : handleUploadPackV0(store, repo, body);
        send(response, 200, out, 'application/x-git-upload-pack-result');
      } catch (error) {
        sendJson(response, 400, { message: error instanceof Error ? error.message : 'bad upload-pack request' });
      }
      return;
    }

    if (service === 'git-receive-pack' && method === 'POST') {
      try {
        const outcome = handleReceivePack(store, repo, body);
        send(response, 200, outcome.body, 'application/x-git-receive-pack-result');
      } catch (error) {
        sendJson(response, 400, { message: error instanceof Error ? error.message : 'bad receive-pack request' });
      }
      return;
    }

    sendJson(response, 404, { message: 'Not Found' });
  }

  function send(response: ServerResponse, status: number, body: string | Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void {
    const headers: Record<string, string> = { 'content-type': contentType, ...extraHeaders };
    response.writeHead(status, headers);
    response.end(body);
  }

  function sendJson(response: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
    send(response, status, JSON.stringify(value), 'application/json; charset=utf-8', extraHeaders);
  }

  async function readBody(request: IncomingMessage, response: ServerResponse): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of request) {
        const buffer = chunk as Buffer;
        total += buffer.length;
        if (total > MAX_BODY_BYTES) {
          sendJson(response, 413, { message: 'request body too large' });
          return null;
        }
        chunks.push(buffer);
      }
    } catch {
      return null;
    }
    return Buffer.concat(chunks);
  }

  return server;
}
