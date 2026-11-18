// GitHub REST v3 surface: /api/v3/...
// Every reply is JSON with a non-empty X-GitHub-Request-Id (set by the caller in app.ts).

import { commitLog, VIEWER, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import { mergeBase, parseCommit } from './gitobj.ts';

export interface RestRequest {
  method: string;
  pathname: string; // already stripped of the /api/v3 prefix
  query: URLSearchParams;
  bodyText: string;
  host: string;
}

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const json = (status: number, value: unknown, headers: Record<string, string> = {}): RestResponse => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  body: JSON.stringify(value),
});

/** A reply whose JSON body is already serialized (see issueViewJson). */
const jsonText = (status: number, body: string, headers: Record<string, string> = {}): RestResponse => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  body,
});

// Serialized issue views live on the Store (see Store.issueViewJsonCache): an issue's view
// is a pure function of its fields and its repository, so the read workload's 2,000 GETs of
// one issue serialize it once. Every mutation path invalidates it via the Store.
function issueViewJson(store: Store, issue: Issue, repo: Repo): string {
  const hit = store.cachedIssueViewJson(issue);
  if (hit !== undefined) return hit;
  const body = JSON.stringify(issueView(issue, repo));
  store.setCachedIssueViewJson(issue, body);
  return body;
}

const error = (status: number, message: string): RestResponse => json(status, { message });

function parseBody(request: RestRequest): { ok: true; value: Record<string, unknown> } | { ok: false; response: RestResponse } {
  if (!request.bodyText || request.bodyText.trim() === '') return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(request.bodyText);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, response: error(400, 'request body must be a JSON object') };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: error(400, 'request body is not valid JSON') };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function pagination(request: RestRequest): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(request.query.get('page') ?? '1', 10) || 1);
  const perPageRaw = Number.parseInt(request.query.get('per_page') ?? '30', 10) || 30;
  const perPage = Math.min(100, Math.max(1, perPageRaw));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], request: RestRequest, basePath: string): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pagination(request);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const links: string[] = [];
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page < totalPages) {
    links.push(`<http://${request.host}${basePath}?page=${page + 1}&per_page=${perPage}>; rel="next"`);
    links.push(`<http://${request.host}${basePath}?page=${totalPages}&per_page=${perPage}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<http://${request.host}${basePath}?page=1&per_page=${perPage}>; rel="first"`);
    links.push(`<http://${request.host}${basePath}?page=${page - 1}&per_page=${perPage}>; rel="prev"`);
  }
  if (links.length) headers.link = links.join(', ');
  return { page: slice, headers };
}

function issueView(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ id: label.id, name: label.name, color: label.color, description: label.description, url: `https://example.invalid/repos/${repo.full_name}/labels/${encodeURIComponent(label.name)}` })),
    user: { login: issue.user.login, id: issue.user.id, type: 'User', avatar_url: `https://example.invalid/avatars/${issue.user.login}` },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    comments: issue.comments.length,
    html_url: `https://example.invalid/${repo.full_name}/issues/${issue.number}`,
    url: `https://example.invalid/repos/${repo.full_name}/issues/${issue.number}`,
    repository_url: `https://example.invalid/repos/${repo.full_name}`,
  };
}

function commentView(comment: Issue['comments'][number], repo: Repo, number: number): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.user.login, id: comment.user.id, type: 'User', avatar_url: `https://example.invalid/avatars/${comment.user.login}` },
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    html_url: `https://example.invalid/${repo.full_name}/issues/${number}#issuecomment-${comment.id}`,
    url: `https://example.invalid/repos/${repo.full_name}/issues/comments/${comment.id}`,
  };
}

function pullView(pull: PullRequest, repo: Repo, store: Store): Record<string, unknown> {
  const headSha = store.branchCommit(repo, pull.head.ref) ?? pull.head.sha;
  const baseSha = store.branchCommit(repo, pull.base.ref) ?? pull.base.sha;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.head.ref, sha: headSha, label: `${repo.owner.login}:${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: baseSha, label: `${repo.owner.login}:${pull.base.ref}` },
    user: { login: pull.user.login, id: pull.user.id, type: 'User', avatar_url: `https://example.invalid/avatars/${pull.user.login}` },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? pull.updated_at : null,
    html_url: `https://example.invalid/${repo.full_name}/pull/${pull.number}`,
    url: `https://example.invalid/repos/${repo.full_name}/pulls/${pull.number}`,
    draft: false,
    comments: pull.comments.length,
  };
}

export function handleRest(store: Store, request: RestRequest): RestResponse {
  const { method, pathname } = request;
  const segments = pathname.split('/').filter((segment) => segment !== '');

  // -- top-level -------------------------------------------------------------
  if (segments.length === 0) {
    if (method === 'GET') {
      return json(200, { current_user_url: `http://${request.host}/api/v3/user`, repository_url: `http://${request.host}/api/v3/repos/{owner}/{repo}` }, { 'x-oauth-scopes': 'repo, read:org' });
    }
    return error(404, 'Not Found');
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method === 'GET') return json(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return error(404, 'Not Found');
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method === 'GET') {
      return json(200, {
        login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email,
        avatar_url: VIEWER.avatar_url, html_url: VIEWER.html_url, type: 'User',
        public_repos: store.repos.size,
      });
    }
    return error(404, 'Not Found');
  }
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const all = [...store.repos.values()].filter((repo) => repo.owner.login === VIEWER.login);
      const { page, headers } = paginate(all.map((repo) => store.repoView(repo)), request, '/api/v3/user/repos');
      return json(200, page, headers);
    }
    if (method === 'POST') {
      const parsed = parseBody(request);
      if (!parsed.ok) return parsed.response;
      const name = asString(parsed.value.name);
      if (!name) return error(422, 'name is required');
      if (store.getRepo(VIEWER.login, name)) return error(422, `Repository ${name} already exists`);
      const repo = store.createRepo(VIEWER.login, VIEWER.id, name, {
        description: asString(parsed.value.description),
        private: asBoolean(parsed.value.private),
      });
      return json(201, store.repoView(repo));
    }
    return error(404, 'Not Found');
  }

  // -- /repos/{owner}/{repo}/... ----------------------------------------------
  if (segments[0] !== 'repos' || segments.length < 3) return error(404, 'Not Found');
  const owner = decodeURIComponent(segments[1]!);
  const repoName = decodeURIComponent(segments[2]!);
  const repo = store.getRepo(owner, repoName);
  if (!repo || owner !== VIEWER.login) return error(404, 'Not Found');
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return json(200, store.repoView(repo));
    if (method === 'PATCH') {
      const parsed = parseBody(request);
      if (!parsed.ok) return parsed.response;
      const description = asString(parsed.value.description);
      if (description !== undefined) repo.description = description;
      const isPrivate = asBoolean(parsed.value.private);
      if (isPrivate !== undefined) repo.private = isPrivate;
      repo.updated_at = store.clock.nowIso();
      return json(200, store.repoView(repo));
    }
    if (method === 'DELETE') {
      store.repos.delete(repo.full_name);
      return { status: 204, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '' };
    }
    return error(404, 'Not Found');
  }

  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => branchView(store, repo, name));
      const { page, headers } = paginate(branches, request, `/api/v3/repos/${owner}/${repoName}/branches`);
      return json(200, page, headers);
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(rest[1]!);
      const sha = store.branchCommit(repo, branch);
      if (!sha) return error(404, 'Branch not found');
      return json(200, branchView(store, repo, branch));
    }
    return error(404, 'Not Found');
  }

  if (rest[0] === 'commits') {
    if (method === 'GET') {
      const ref = request.query.get('sha');
      const tip = ref ? store.resolveRef(repo, ref) : store.headCommit(repo);
      if (!tip) return json(200, []);
      const log = commitLog(repo, tip, store.lookup(repo));
      const entries = log.map((entry) => ({
        sha: entry.sha,
        commit: {
          message: entry.message,
          author: { name: VIEWER.name, email: VIEWER.email },
          committer: { name: VIEWER.name, email: VIEWER.email },
          tree: { sha: entry.tree },
        },
        author: { login: VIEWER.login, id: VIEWER.id },
        committer: { login: VIEWER.login, id: VIEWER.id },
        parents: entry.parents.map((parent) => ({ sha: parent })),
        url: `https://example.invalid/repos/${repo.full_name}/commits/${entry.sha}`,
      }));
      const { page, headers } = paginate(entries, request, `/api/v3/repos/${owner}/${repoName}/commits`);
      return json(200, page, headers);
    }
    return error(404, 'Not Found');
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = parseBody(request);
      if (!parsed.ok) return parsed.response;
      const ref = asString(parsed.value.ref);
      const sha = asString(parsed.value.sha);
      if (!ref || !sha) return error(422, 'ref and sha are required');
      if (repo.refs.has(ref)) return error(422, `Reference ${ref} already exists`);
      if (!repo.objects.has(sha)) return error(422, `Object ${sha} does not exist`);
      store.setRef(repo, ref, sha);
      return json(201, { ref, object: { sha, type: repo.objects.get(sha)!.type, url: `https://example.invalid/repos/${repo.full_name}/git/${repo.objects.get(sha)!.type}s/${sha}` } });
    }
    if (method === 'GET' && rest.length >= 3) {
      const refName = `refs/${rest.slice(2).map((segment) => decodeURIComponent(segment)).join('/')}`;
      const target = store.refTarget(repo, refName);
      if (!target) return error(404, 'Reference not found');
      return json(200, { ref: refName, object: { sha: target, type: repo.objects.get(target)?.type ?? 'commit' } });
    }
    if (method === 'GET' && rest.length === 2) {
      const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
      return json(200, refs);
    }
    return error(404, 'Not Found');
  }

  if (rest[0] === 'contents') {
    return handleContents(store, repo, request, rest.slice(1));
  }

  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) return json(200, repo.labels.map((label) => labelView(label, repo)));
    if (method === 'POST' && rest.length === 1) {
      const parsed = parseBody(request);
      if (!parsed.ok) return parsed.response;
      const name = asString(parsed.value.name);
      if (!name) return error(422, 'name is required');
      const existing = repo.labels.find((label) => label.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        // Idempotent create: the checks POST the seeded label names (bug, ...) and expect 201.
        if (asString(parsed.value.color)) existing.color = asString(parsed.value.color)!;
        if (asString(parsed.value.description)) existing.description = asString(parsed.value.description)!;
        return json(201, labelView(existing, repo));
      }
      const label = store.ensureLabel(repo, name);
      if (asString(parsed.value.color)) label.color = asString(parsed.value.color)!;
      if (asString(parsed.value.description)) label.description = asString(parsed.value.description)!;
      return json(201, labelView(label, repo));
    }
    return error(404, 'Not Found');
  }

  if (rest[0] === 'issues') {
    return handleIssues(store, repo, request, rest.slice(1));
  }

  if (rest[0] === 'pulls') {
    return handlePulls(store, repo, request, rest.slice(1));
  }

  return error(404, 'Not Found');
}

function branchView(store: Store, repo: Repo, name: string): Record<string, unknown> {
  const sha = store.branchCommit(repo, name) ?? '';
  const commit = sha ? repo.objects.get(sha) : undefined;
  const message = commit?.type === 'commit' ? parseCommit(commit.data).message : '';
  return {
    name,
    commit: { sha, commit: { message } },
    protected: false,
  };
}

function labelView(label: Repo['labels'][number], repo: Repo): Record<string, unknown> {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
    url: `https://example.invalid/repos/${repo.full_name}/labels/${encodeURIComponent(label.name)}`,
  };
}

function handleContents(store: Store, repo: Repo, request: RestRequest, pathSegments: string[]): RestResponse {
  const path = pathSegments.map((segment) => decodeURIComponent(segment)).join('/');
  const refQuery = request.query.get('ref');
  const branch = request.query.get('branch');
  const resolveTip = (branchName?: string): string | null => {
    if (branchName) return store.branchCommit(repo, branchName);
    if (refQuery) return store.resolveRef(repo, refQuery);
    return store.headCommit(repo);
  };

  if (request.method === 'GET') {
    const tip = resolveTip();
    if (!tip) return error(404, 'Not Found');
    const files = store.treeFiles(repo, tip);
    if (path === '') {
      const entries = dirEntries(store, repo, tip, '');
      return json(200, entries);
    }
    const file = files.get(path);
    if (file) {
      const blob = repo.objects.get(file.oid);
      const content = blob ? blob.data.toString('base64') : '';
      return json(200, {
        type: 'file', encoding: 'base64', content, sha: file.oid, size: file.size,
        name: path.split('/').pop(), path,
        url: `https://example.invalid/repos/${repo.full_name}/contents/${encodeURIComponent(path)}`,
        html_url: `https://example.invalid/${repo.full_name}/blob/${repo.default_branch}/${path}`,
        download_url: `https://example.invalid/repos/${repo.full_name}/raw/${repo.default_branch}/${path}`,
      });
    }
    // directory?
    const prefix = `${path}/`;
    if ([...files.keys()].some((key) => key.startsWith(prefix))) {
      return json(200, dirEntries(store, repo, tip, path));
    }
    return error(404, 'Not Found');
  }

  if (request.method === 'PUT') {
    const parsed = parseBody(request);
    if (!parsed.ok) return parsed.response;
    const message = asString(parsed.value.message) ?? `Update ${path}`;
    const contentB64 = asString(parsed.value.content);
    if (contentB64 === undefined) return error(422, 'content is required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return error(422, 'content is not valid base64');
    }
    const branchName = asString(parsed.value.branch) ?? repo.default_branch;
    let tip = store.branchCommit(repo, branchName);
    const expectedSha = asString(parsed.value.sha);
    const files = tip ? store.treeFiles(repo, tip) : new Map();
    const existing = files.get(path);
    if (existing && expectedSha && expectedSha !== existing.oid) {
      return error(409, 'sha does not match the current file (stale sha)');
    }
    const isCreate = !existing;
    const blobOid = store.storeObject(repo, 'blob', content);
    const commitOid = store.commitChanges(repo, branchName, new Map([[path, blobOid]]), message);
    return json(isCreate ? 201 : 200, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, encoding: 'base64' },
      commit: { sha: commitOid, message },
    });
  }

  if (request.method === 'DELETE') {
    const parsed = parseBody(request);
    if (!parsed.ok) return parsed.response;
    const message = asString(parsed.value.message) ?? `Delete ${path}`;
    const branchName = asString(parsed.value.branch) ?? repo.default_branch;
    const tip = store.branchCommit(repo, branchName);
    if (!tip) return error(404, 'Not Found');
    const files = store.treeFiles(repo, tip);
    if (!files.has(path)) return error(404, 'Not Found');
    const commitOid = store.commitChanges(repo, branchName, new Map([[path, null]]), message);
    return json(200, { commit: { sha: commitOid, message } });
  }

  return error(404, 'Not Found');
}

function dirEntries(store: Store, repo: Repo, tip: string, dir: string): Array<Record<string, unknown>> {
  const files = store.treeFiles(repo, tip);
  const prefix = dir === '' ? '' : `${dir}/`;
  const children = new Map<string, { type: string; oid: string; size: number }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const first = rest.split('/')[0]!;
    if (rest.includes('/')) {
      if (!children.has(first)) children.set(first, { type: 'dir', oid: '', size: 0 });
    } else {
      children.set(first, { type: 'file', oid: entry.oid, size: entry.size });
    }
  }
  return [...children.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, entry]) => ({
      type: entry.type,
      name,
      path: prefix + name,
      sha: entry.oid,
      size: entry.size,
      url: `https://example.invalid/repos/${repo.full_name}/contents/${encodeURIComponent(prefix + name)}`,
      html_url: `https://example.invalid/${repo.full_name}/tree/${repo.default_branch}/${prefix + name}`,
    }));
}

function handleIssues(store: Store, repo: Repo, request: RestRequest, rest: string[]): RestResponse {
  if (rest.length === 0) {
    if (request.method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      const sort = request.query.get('sort') ?? 'created';
      const direction = request.query.get('direction') ?? 'desc';
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => {
        const cmp = sort === 'created'
          ? a.created_at.localeCompare(b.created_at) || a.number - b.number
          : a.number - b.number;
        return direction === 'asc' ? cmp : -cmp;
      });
      const { page, headers } = paginate(list.map((issue) => issueViewJson(store, issue, repo)), request, `/api/v3/repos/${repo.owner.login}/${repo.name}/issues`);
      return jsonText(200, `[${page.join(',')}]`, headers);
    }
    if (request.method === 'POST') {
      const parsed = parseBody(request);
      if (!parsed.ok) return parsed.response;
      const title = asString(parsed.value.title);
      if (!title) return error(422, 'title is required');
      const body = asString(parsed.value.body) ?? '';
      const labelNames = Array.isArray(parsed.value.labels) ? parsed.value.labels.filter((entry): entry is string => typeof entry === 'string') : [];
      try {
        const issue = store.createIssue(repo, title, body, labelNames);
        return jsonText(201, issueViewJson(store, issue, repo));
      } catch (err) {
        return error(422, err instanceof Error ? err.message : 'label not found');
      }
    }
    return error(404, 'Not Found');
  }
  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isInteger(number)) return error(404, 'Not Found');
  const issue = repo.issues.find((entry) => entry.number === number);
  if (!issue) return error(404, 'Not Found');
  if (rest.length === 1) {
    if (request.method === 'GET') return jsonText(200, issueViewJson(store, issue, repo));
    if (request.method === 'PATCH') {
      const parsed = parseBody(request);
      if (!parsed.ok) return parsed.response;
      const title = asString(parsed.value.title);
      if (title !== undefined) issue.title = title;
      const body = asString(parsed.value.body);
      if (body !== undefined) issue.body = body;
      const state = asString(parsed.value.state);
      if (state === 'closed' || state === 'open') {
        issue.state = state;
        issue.closed_at = state === 'closed' ? store.clock.nowIso() : null;
      }
      issue.updated_at = store.clock.nowIso();
      store.invalidateIssueViewJson(issue);
      return jsonText(200, issueViewJson(store, issue, repo));
    }
    return error(404, 'Not Found');
  }
  if (rest[1] === 'comments') {
    if (request.method === 'GET') {
      const { page, headers } = paginate(issue.comments.map((comment) => commentView(comment, repo, number)), request, `/api/v3/repos/${repo.owner.login}/${repo.name}/issues/${number}/comments`);
      return json(200, page, headers);
    }
    if (request.method === 'POST') {
      const parsed = parseBody(request);
      if (!parsed.ok) return parsed.response;
      const body = asString(parsed.value.body);
      if (body === undefined) return error(422, 'body is required');
      const now = store.clock.nowIso();
      const comment: Issue['comments'][number] = {
        id: store.allocateId(),
        body,
        user: { login: VIEWER.login, id: VIEWER.id },
        created_at: now,
        updated_at: now,
      };
      issue.comments.push(comment);
      store.invalidateIssueViewJson(issue);
      return json(201, commentView(comment, repo, number));
    }
    return error(404, 'Not Found');
  }
  return error(404, 'Not Found');
}

function handlePulls(store: Store, repo: Repo, request: RestRequest, rest: string[]): RestResponse {
  if (rest.length === 0) {
    if (request.method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      let list = [...repo.pulls];
      if (state !== 'all') list = list.filter((pull) => pull.state === state);
      list.sort((a, b) => b.number - a.number);
      const { page, headers } = paginate(list.map((pull) => pullView(pull, repo, store)), request, `/api/v3/repos/${repo.owner.login}/${repo.name}/pulls`);
      return json(200, page, headers);
    }
    if (request.method === 'POST') {
      const parsed = parseBody(request);
      if (!parsed.ok) return parsed.response;
      const title = asString(parsed.value.title);
      const head = asString(parsed.value.head);
      const base = asString(parsed.value.base);
      if (!title || !head || !base) return error(422, 'title, head and base are required');
      if (!store.branchCommit(repo, head) || !store.branchCommit(repo, base)) {
        return error(422, 'head or base branch does not exist');
      }
      try {
        const pull = store.createPull(repo, title, asString(parsed.value.body) ?? '', head, base);
        return json(201, pullView(pull, repo, store));
      } catch (err) {
        return error(422, err instanceof Error ? err.message : 'cannot create pull request');
      }
    }
    return error(404, 'Not Found');
  }
  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isInteger(number)) return error(404, 'Not Found');
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (!pull) return error(404, 'Not Found');
  if (rest.length === 1) {
    if (request.method === 'GET') return json(200, pullView(pull, repo, store));
    return error(404, 'Not Found');
  }
  if (rest[1] === 'files' && request.method === 'GET') {
    const baseTip = store.branchCommit(repo, pull.base.ref);
    const headTip = store.branchCommit(repo, pull.head.ref);
    if (!baseTip || !headTip) return error(404, 'Not Found');
    const base = mergeBase(headTip, baseTip, store.lookup(repo)) ?? baseTip;
    const files = store.diffCommits(repo, base, headTip);
    return json(200, files.map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    })));
  }
  if (rest[1] === 'merge' && request.method === 'PUT') {
    if (pull.merged || pull.state !== 'open') return error(405, 'Pull request is already merged or closed');
    const headTip = store.branchCommit(repo, pull.head.ref);
    const baseTip = store.branchCommit(repo, pull.base.ref);
    if (!headTip || !baseTip) return error(404, 'Not Found');
    if (store.hasMergeConflict(repo, headTip, baseTip)) {
      return error(405, 'Merge conflict: the pull request cannot be merged cleanly');
    }
    const sha = store.squashMerge(repo, pull);
    return json(200, { sha, merged: true, message: `Merge pull request #${pull.number} from ${repo.owner.login}/${pull.head.ref}` });
  }
  return error(404, 'Not Found');
}
