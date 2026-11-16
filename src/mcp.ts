// MCP endpoint (POST /mcp): JSON-RPC 2.0 over streamable HTTP, plain JSON answers.
// Modern era 2026-07-28 via server/discover, legacy era via initialize + notifications/initialized.

import { VIEWER, type Store } from './store.ts';

export const MCP_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user).' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(object: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(object) }],
    structuredContent: object,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function repoViewForMcp(store: Store, owner: string, repoName: string): Record<string, unknown> | null {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return null;
  return store.repoView(repo) as unknown as Record<string, unknown>;
}

function issueViewForMcp(store: Store, owner: string, repoName: string, issue: ReturnType<Store['createIssue']>): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
    user: { login: issue.user.login, id: issue.user.id },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    comments: issue.comments.length,
    url: `https://example.invalid/repos/${owner}/${repoName}/issues/${issue.number}`,
  };
}

function pullViewForMcp(store: Store, repoName: string, pull: ReturnType<Store['createPull']>): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.merged ? false : true,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
    user: { login: pull.user.login, id: pull.user.id },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    url: `https://example.invalid/repos/${repoName}/pull/${pull.number}`,
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { result: Record<string, unknown> } | { rpcError: { code: number; message: string } } {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) return { rpcError: { code: -32601, message: `Method not found: ${name}` } };
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length) {
    return { result: toolError(`missing required argument(s): ${missing.join(', ')}`) };
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = String(args.name);
        const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER.login;
        if (owner !== VIEWER.login) return { result: toolError(`owner ${owner} is not the authenticated user`) };
        if (store.getRepo(owner, repoName)) return { result: toolError(`Repository ${repoName} already exists`) };
        const repo = store.createRepo(owner, VIEWER.id, repoName, {
          description: typeof args.description === 'string' ? args.description : undefined,
          private: typeof args.private === 'boolean' ? args.private : undefined,
        });
        return { result: toolResult(store.repoView(repo)) };
      }
      case 'get_repo': {
        const view = repoViewForMcp(store, String(args.owner), String(args.repo));
        if (!view) return { result: toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`) };
        return { result: toolResult(view) };
      }
      case 'create_issue': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (!repo) return { result: toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`) };
        const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
        return { result: toolResult(issueViewForMcp(store, String(args.owner), String(args.repo), issue)) };
      }
      case 'list_issues': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (!repo) return { result: toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`) };
        const state = typeof args.state === 'string' ? args.state : 'open';
        const list = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
        const views = list.map((issue) => issueViewForMcp(store, String(args.owner), String(args.repo), issue));
        return { result: toolResult({ issues: views }) };
      }
      case 'create_pull_request': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (!repo) return { result: toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`) };
        const head = String(args.head);
        const base = String(args.base);
        if (!store.branchCommit(repo, head) || !store.branchCommit(repo, base)) {
          return { result: toolError('head or base branch does not exist') };
        }
        const pull = store.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
        return { result: toolResult(pullViewForMcp(store, String(args.repo), pull)) };
      }
      case 'merge_pull_request': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (!repo) return { result: toolError(`repository ${String(args.owner)}/${String(args.repo)} not found`) };
        const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
        const pull = repo.pulls.find((entry) => entry.number === pullNumber);
        if (!pull) return { result: toolError(`pull request #${pullNumber} not found`) };
        if (pull.merged || pull.state !== 'open') return { result: toolError(`pull request #${pullNumber} is already merged or closed`) };
        const headTip = store.branchCommit(repo, pull.head.ref);
        const baseTip = store.branchCommit(repo, pull.base.ref);
        if (!headTip || !baseTip) return { result: toolError('head or base branch does not exist') };
        if (store.hasMergeConflict(repo, headTip, baseTip)) return { result: toolError('merge conflict') };
        const sha = store.squashMerge(repo, pull);
        return { result: toolResult({ ...pullViewForMcp(store, String(args.repo), pull), sha, merged: true }) };
      }
      default:
        return { rpcError: { code: -32601, message: `Method not found: ${name}` } };
    }
  } catch (error) {
    return { result: toolError(error instanceof Error ? error.message : 'tool call failed') };
  }
}

export interface McpResponse {
  status: number;
  body: string; // '' for 202 empty
}

/** Handle one POST /mcp body (already read). Returns the HTTP status and body. */
export function handleMcp(store: Store, bodyText: string): McpResponse {
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    request = parsed as Record<string, unknown>;
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params) ? request.params : {}) as Record<string, unknown>;

  const ok = (result: unknown): McpResponse => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id, result }),
  });
  const rpcError = (code: number, message: string, data?: unknown): McpResponse => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }),
  });

  // Notifications (no id) are answered with 202 and no body.
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: '' };
  }

  switch (method) {
    case 'server/discover': {
      return ok({
        resultType: 'discover',
        supportedVersions: [...MCP_REVISIONS],
        capabilities: { tools: {} },
        instructions: 'A GitHub-compatible git forge.',
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = MCP_REVISIONS.includes(offered) ? offered : MCP_REVISIONS[1]!;
      return ok({
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list': {
      return ok({ tools: TOOLS });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
      const outcome = callTool(store, name, args);
      if ('rpcError' in outcome) return rpcError(outcome.rpcError.code, outcome.rpcError.message);
      return ok(outcome.result);
    }
    default:
      return rpcError(-32601, `Method not found: ${method}`);
  }
}
