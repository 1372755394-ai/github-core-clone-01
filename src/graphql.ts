// GraphQL executor for /api/graphql: a small recursive-descent parser plus resolvers
// for the documented operations (viewer, repository, node, __type, issue/PR mutations).
// Unknown fields produce HTTP 200 with an `errors` array naming the field.

import { mergeBase } from './gitobj.ts';
import { VIEWER, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

export interface GraphQLExecution {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

// -- global ids ----------------------------------------------------------------

export function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0]!, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

// -- parser ----------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  alias: string | null;
  name: string;
  arguments: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}

class ParseError extends Error {}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (text.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if ('{}()[]:!=$'.includes(ch)) { tokens.push(ch); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          const esc = text[j + 1]!;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += text[j]!;
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9.eE+-]/.test(text[j]!)) j += 1;
      tokens.push(text.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j]!)) j += 1;
      tokens.push(text.slice(i, j));
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new ParseError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new ParseError(`expected ${token}, got ${got}`);
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new ParseError('empty document');
    return operations;
  }

  private parseOperation(): OperationNode {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first === 'query' || first === 'mutation') {
      type = this.next() as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName !== '(' && maybeName !== '{') name = this.next();
    }
    const variableDefinitions: OperationNode['variableDefinitions'] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        this.expect('$');
        const varName = this.next();
        this.expect(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek() === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefinitions.push({ name: varName, defaultValue });
      }
      this.expect(')');
    }
    const selectionSet = this.parseSelectionSet();
    return { type, name, variableDefinitions, selectionSet };
  }

  private parseType(): void {
    // Type names, list brackets and ! markers: consume until a token that cannot be part of a type.
    let depth = 0;
    for (;;) {
      const token = this.peek();
      if (token === '[') { depth += 1; this.next(); continue; }
      if (token === ']') { depth -= 1; this.next(); continue; }
      if (token === '!') { this.next(); continue; }
      if (token !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token) && token !== 'query' && token !== 'mutation') {
        this.next();
        continue;
      }
      return;
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        let typeCondition: string | null = null;
        if (this.peek() === 'on') {
          this.next();
          typeCondition = this.next();
        }
        selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let alias: string | null = null;
    let name = this.next();
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: FieldNode['arguments'] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    // Directives: skip them (none of the suite documents use any).
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token === '(') depth += 1;
          else if (token === ')') depth -= 1;
        }
      }
    }
    const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : [];
    return { alias, name, arguments: args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string': case 'int': case 'float': case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// -- executor ------------------------------------------------------------------

interface Ctx {
  store: Store;
  errors: Array<{ message: string }>;
}

type AnyObject =
  | { __type: 'User'; login: string; id: number }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: PullRequest }
  | { __type: 'IssueConnection'; repo: Repo; nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __type: 'PullRequestConnection'; repo: Repo; nodes: PullRequest[] }
  | { __type: 'PullRequestFileConnection'; repo: Repo; nodes: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> }
  | { __type: 'Type'; name: string }
  | { __type: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CreatePullRequestPayload'; repo: Repo; pull: PullRequest }
  | { __type: 'MergePullRequestPayload'; repo: Repo; pull: PullRequest }
  | { __type: 'AddCommentPayload'; repo: Repo; issueNumber: number; comment: { id: number; body: string } }
  | { __type: 'CommentEdge'; repo: Repo; issueNumber: number; comment: { id: number; body: string } }
  | { __type: 'IssueComment'; repo: Repo; issueNumber: number; comment: { id: number; body: string } };

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'author', 'url', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'description', 'isPrivate'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl'],
  SearchType: [],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'WIKI', 'PACKAGE'];

function findRepoByGid(store: Store, id: string): Repo | null {
  const decoded = decodeGid(id);
  if (!decoded || decoded.kind !== 'Repository' || decoded.parts.length !== 1) return null;
  const dbid = Number(decoded.parts[0]);
  for (const repo of store.repos.values()) if (repo.id === dbid) return repo;
  return null;
}

function findIssueByGid(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGid(id);
  if (!decoded || decoded.kind !== 'Issue' || decoded.parts.length !== 2) return null;
  const repoId = Number(decoded.parts[0]);
  const number = Number(decoded.parts[1]);
  for (const repo of store.repos.values()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.find((entry) => entry.number === number);
    if (issue) return { repo, issue };
  }
  return null;
}

function findPullByGid(store: Store, id: string): { repo: Repo; pull: PullRequest } | null {
  const decoded = decodeGid(id);
  if (!decoded || decoded.kind !== 'PullRequest' || decoded.parts.length !== 2) return null;
  const repoId = Number(decoded.parts[0]);
  const number = Number(decoded.parts[1]);
  for (const repo of store.repos.values()) {
    if (repo.id !== repoId) continue;
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull) return { repo, pull };
  }
  return null;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullMergeable(store: Store, repo: Repo, pull: PullRequest): string {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  const headTip = store.branchCommit(repo, pull.head.ref);
  const baseTip = store.branchCommit(repo, pull.base.ref);
  if (!headTip || !baseTip) return 'UNKNOWN';
  return store.hasMergeConflict(repo, headTip, baseTip) ? 'CONFLICTING' : 'MERGEABLE';
}

function resolveObjectField(ctx: Ctx, obj: AnyObject, field: FieldNode, variables: Record<string, unknown>): unknown {
  const args: Record<string, unknown> = {};
  for (const arg of field.arguments) args[arg.name] = resolveValue(arg.value, variables);
  switch (obj.__type) {
    case 'User': {
      if (field.name === 'login') return obj.login;
      if (field.name === 'id') return gid('User', obj.id);
      if (field.name === 'name') return 'ada iversen';
      if (field.name === 'email') return 'adaiversen@example.invalid';
      break;
    }
    case 'Repository': {
      const repo = obj.repo;
      switch (field.name) {
        case 'id': return gid('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.full_name;
        case 'owner': return { __type: 'User', login: repo.owner.login, id: repo.owner.id } as AnyObject;
        case 'defaultBranchRef': return repo.default_branch ? { name: repo.default_branch } : null;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return repo.has_issues;
        case 'description': return repo.description;
        case 'isPrivate': return repo.private;
        case 'createdAt': return repo.created_at;
        case 'updatedAt': return repo.updated_at;
        case 'issue': {
          const number = args.number as number | undefined;
          const issue = typeof number === 'number' ? repo.issues.find((entry) => entry.number === number) : undefined;
          return issue ? ({ __type: 'Issue', repo, issue } as AnyObject) : null;
        }
        case 'issues': {
          let list = [...repo.issues];
          const states = args.states as string[] | undefined;
          if (Array.isArray(states) && states.length) {
            list = list.filter((issue) => states.includes(issueState(issue)));
          }
          const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
          const direction = orderBy?.direction ?? 'DESC';
          list.sort((a, b) => {
            const cmp = a.created_at.localeCompare(b.created_at) || a.number - b.number;
            return direction === 'ASC' ? cmp : -cmp;
          });
          const first = typeof args.first === 'number' ? args.first : list.length;
          let start = 0;
          if (typeof args.after === 'string') {
            const decoded = decodeGid(args.after);
            if (decoded?.kind === 'cursor' && decoded.parts[0] !== undefined) start = Number(decoded.parts[0]) + 1;
          }
          const nodes = list.slice(start, start + first);
          const endIndex = start + nodes.length - 1;
          return {
            __type: 'IssueConnection',
            repo,
            nodes,
            pageInfo: {
              hasNextPage: endIndex + 1 < list.length,
              endCursor: nodes.length ? gid('cursor', endIndex) : null,
            },
          } as AnyObject;
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
          const nodes = [...repo.pulls].sort((a, b) => b.number - a.number).slice(0, first);
          return { __type: 'PullRequestConnection', repo, nodes } as AnyObject;
        }
        case 'pullRequest': {
          const number = args.number as number | undefined;
          const pull = typeof number === 'number' ? repo.pulls.find((entry) => entry.number === number) : undefined;
          return pull ? ({ __type: 'PullRequest', repo, pull } as AnyObject) : null;
        }
      }
      break;
    }
    case 'Issue': {
      const issue = obj.issue;
      switch (field.name) {
        case 'id': return gid('Issue', obj.repo.id, issue.number);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issueState(issue);
        case 'body': return issue.body;
        case 'createdAt': return issue.created_at;
        case 'updatedAt': return issue.updated_at;
        case 'closedAt': return issue.closed_at;
        case 'author': return { __type: 'User', login: issue.user.login, id: issue.user.id } as AnyObject;
        case 'url': return `https://example.invalid/${obj.repo.full_name}/issues/${issue.number}`;
        case 'repository': return { __type: 'Repository', repo: obj.repo } as AnyObject;
      }
      break;
    }
    case 'PullRequest': {
      const pull = obj.pull;
      switch (field.name) {
        case 'id': return gid('PullRequest', obj.repo.id, pull.number);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pullState(pull);
        case 'merged': return pull.merged;
        case 'mergeable': return pullMergeable(ctx.store, obj.repo, pull);
        case 'headRefName': return pull.head.ref;
        case 'baseRefName': return pull.base.ref;
        case 'createdAt': return pull.created_at;
        case 'updatedAt': return pull.updated_at;
        case 'mergedAt': return pull.merged_at;
        case 'author': return { __type: 'User', login: pull.user.login, id: pull.user.id } as AnyObject;
        case 'url': return `https://example.invalid/${obj.repo.full_name}/pull/${pull.number}`;
        case 'repository': return { __type: 'Repository', repo: obj.repo } as AnyObject;
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : 100;
          const baseTip = ctx.store.branchCommit(obj.repo, pull.base.ref);
          const headTip = ctx.store.branchCommit(obj.repo, pull.head.ref);
          let nodes: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
          if (baseTip && headTip) {
            const base = mergeBase(headTip, baseTip, ctx.store.lookup(obj.repo)) ?? baseTip;
            nodes = ctx.store.diffCommits(obj.repo, base, headTip).slice(0, first);
          }
          return { __type: 'PullRequestFileConnection', repo: obj.repo, nodes } as AnyObject;
        }
      }
      break;
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') return obj.nodes.map((issue) => ({ __type: 'Issue', repo: obj.repo, issue } as AnyObject));
      if (field.name === 'pageInfo') return obj.pageInfo;
      if (field.name === 'totalCount') return obj.nodes.length;
      break;
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return obj.nodes.map((pull) => ({ __type: 'PullRequest', repo: obj.repo, pull } as AnyObject));
      if (field.name === 'totalCount') return obj.nodes.length;
      break;
    }
    case 'PullRequestFileConnection': {
      if (field.name === 'nodes') return obj.nodes.map((file) => ({ path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes }));
      if (field.name === 'totalCount') return obj.nodes.length;
      break;
    }
    case 'Type': {
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[obj.name] ?? [];
        return names.map((name) => ({ name }));
      }
      if (field.name === 'enumValues') {
        if (obj.name === 'SearchType') return SEARCH_TYPE_VALUES.map((name) => ({ name }));
        return [];
      }
      if (field.name === 'name') return obj.name;
      break;
    }
    case 'CreateIssuePayload': {
      if (field.name === 'issue') return { __type: 'Issue', repo: obj.repo, issue: obj.issue } as AnyObject;
      break;
    }
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return { __type: 'Issue', repo: obj.repo, issue: obj.issue } as AnyObject;
      break;
    }
    case 'CreatePullRequestPayload': {
      if (field.name === 'pullRequest') return { __type: 'PullRequest', repo: obj.repo, pull: obj.pull } as AnyObject;
      break;
    }
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return { __type: 'PullRequest', repo: obj.repo, pull: obj.pull } as AnyObject;
      break;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return { __type: 'CommentEdge', repo: obj.repo, issueNumber: obj.issueNumber, comment: obj.comment } as AnyObject;
      break;
    }
    case 'CommentEdge': {
      if (field.name === 'node') return { __type: 'IssueComment', repo: obj.repo, issueNumber: obj.issueNumber, comment: obj.comment } as AnyObject;
      break;
    }
    case 'IssueComment': {
      if (field.name === 'id') return gid('IssueComment', obj.repo.id, obj.issueNumber, obj.comment.id);
      if (field.name === 'body') return obj.comment.body;
      break;
    }
  }
  return undefined;
}

/** Known scalar/object fields for a type, used to report unknown fields. */
function knownFields(obj: AnyObject): Set<string> {
  switch (obj.__type) {
    case 'User': return new Set(['login', 'id', 'name', 'email', 'avatarUrl', '__typename']);
    case 'Repository': return new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', '__typename']);
    case 'Issue': return new Set(['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'repository', '__typename']);
    case 'PullRequest': return new Set(['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'author', 'url', 'repository', '__typename']);
    case 'IssueConnection': return new Set(['nodes', 'pageInfo', 'totalCount', '__typename']);
    case 'PullRequestConnection': return new Set(['nodes', 'totalCount', '__typename']);
    case 'PullRequestFileConnection': return new Set(['nodes', 'totalCount', '__typename']);
    case 'Type': return new Set(['fields', 'enumValues', 'name', '__typename']);
    case 'CreateIssuePayload': return new Set(['issue', '__typename']);
    case 'CloseIssuePayload': return new Set(['issue', '__typename']);
    case 'CreatePullRequestPayload': return new Set(['pullRequest', '__typename']);
    case 'MergePullRequestPayload': return new Set(['pullRequest', '__typename']);
    case 'AddCommentPayload': return new Set(['commentEdge', '__typename']);
    case 'CommentEdge': return new Set(['node', '__typename']);
    case 'IssueComment': return new Set(['id', 'body', '__typename']);
    default: return new Set(['__typename']);
  }
}

function typeNameOf(obj: AnyObject): string {
  switch (obj.__type) {
    case 'User': return 'User';
    case 'Repository': return 'Repository';
    case 'Issue': return 'Issue';
    case 'PullRequest': return 'PullRequest';
    case 'IssueConnection': return 'IssueConnection';
    case 'PullRequestConnection': return 'PullRequestConnection';
    case 'PullRequestFileConnection': return 'PullRequestFileConnection';
    case 'Type': return '__Type';
    case 'CreateIssuePayload': return 'CreateIssuePayload';
    case 'CloseIssuePayload': return 'CloseIssuePayload';
    case 'CreatePullRequestPayload': return 'CreatePullRequestPayload';
    case 'MergePullRequestPayload': return 'MergePullRequestPayload';
    case 'AddCommentPayload': return 'AddCommentPayload';
    case 'CommentEdge': return 'IssueCommentEdge';
    case 'IssueComment': return 'IssueComment';
  }
}

function isObjectValue(value: unknown): value is AnyObject {
  return typeof value === 'object' && value !== null && '__type' in (value as Record<string, unknown>);
}

function executeSelectionSet(ctx: Ctx, obj: AnyObject | null, selections: SelectionNode[], variables: Record<string, unknown>): Record<string, unknown> | null {
  if (obj === null) return null;
  const out: Record<string, unknown> = {};
  const known = knownFields(obj);
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      const typeName = typeNameOf(obj);
      if (selection.typeCondition && selection.typeCondition !== typeName) continue;
      const nested = executeSelectionSet(ctx, obj, selection.selectionSet, variables);
      if (nested) Object.assign(out, nested);
      continue;
    }
    const field = selection.field;
    const responseName = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseName] = typeNameOf(obj);
      continue;
    }
    if (!known.has(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeNameOf(obj)}".` });
      continue;
    }
    const value = resolveObjectField(ctx, obj, field, variables);
    if (value === undefined) continue;
    if (field.selectionSet.length === 0) {
      out[responseName] = value;
      continue;
    }
    if (isObjectValue(value)) {
      out[responseName] = executeSelectionSet(ctx, value, field.selectionSet, variables);
    } else if (Array.isArray(value)) {
      out[responseName] = value.map((entry) => (isObjectValue(entry) ? executeSelectionSet(ctx, entry, field.selectionSet, variables) : entry));
    } else if (value !== null && typeof value === 'object') {
      // Plain object (pageInfo, owner-less records): resolve scalar fields directly.
      const record = value as Record<string, unknown>;
      const nested: Record<string, unknown> = {};
      for (const sub of field.selectionSet) {
        if (sub.kind === 'field') nested[sub.field.alias ?? sub.field.name] = record[sub.field.name] ?? null;
      }
      out[responseName] = nested;
    } else {
      out[responseName] = value;
    }
  }
  return out;
}

function resolveRootField(ctx: Ctx, field: FieldNode, variables: Record<string, unknown>): AnyObject | null | undefined {
  const store = ctx.store;
  const args: Record<string, unknown> = {};
  for (const arg of field.arguments) args[arg.name] = resolveValue(arg.value, variables);
  switch (field.name) {
    case 'viewer':
      return { __type: 'User', login: VIEWER.login, id: VIEWER.id };
    case 'repository': {
      const owner = args.owner as string | undefined;
      const name = args.name as string | undefined;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = store.getRepo(owner, name);
      if (!repo || owner !== VIEWER.login) return null;
      return { __type: 'Repository', repo };
    }
    case 'node': {
      const id = args.id as string | undefined;
      if (typeof id !== 'string') return null;
      const repo = findRepoByGid(store, id);
      if (repo) return { __type: 'Repository', repo };
      const issue = findIssueByGid(store, id);
      if (issue) return { __type: 'Issue', repo: issue.repo, issue: issue.issue };
      const pull = findPullByGid(store, id);
      if (pull) return { __type: 'PullRequest', repo: pull.repo, pull: pull.pull };
      return null;
    }
    case '__type': {
      const name = args.name as string | undefined;
      if (typeof name !== 'string') return null;
      if (name === 'Issue' || name === 'PullRequest' || name === 'Repository' || name === 'SearchType' || name === 'User') {
        return { __type: 'Type', name };
      }
      return null;
    }
    case '__schema':
      return null;
    case 'createIssue': {
      const input = args.input as Record<string, unknown> | undefined;
      const repo = input && typeof input.repositoryId === 'string' ? findRepoByGid(store, input.repositoryId) : null;
      if (!repo) throw new Error('createIssue: repository not found');
      const title = typeof input?.title === 'string' ? input.title : '';
      const body = typeof input?.body === 'string' ? input.body : '';
      const issue = store.createIssue(repo, title, body, []);
      return { __type: 'CreateIssuePayload', repo, issue };
    }
    case 'closeIssue': {
      const input = args.input as Record<string, unknown> | undefined;
      const found = input && typeof input.issueId === 'string' ? findIssueByGid(store, input.issueId) : null;
      if (!found) throw new Error('closeIssue: issue not found');
      found.issue.state = 'closed';
      found.issue.closed_at = store.clock.nowIso();
      found.issue.updated_at = found.issue.closed_at;
      return { __type: 'CloseIssuePayload', repo: found.repo, issue: found.issue };
    }
    case 'createPullRequest': {
      const input = args.input as Record<string, unknown> | undefined;
      const repo = input && typeof input.repositoryId === 'string' ? findRepoByGid(store, input.repositoryId) : null;
      if (!repo) throw new Error('createPullRequest: repository not found');
      const baseRefName = typeof input?.baseRefName === 'string' ? input.baseRefName : repo.default_branch;
      const headRefName = typeof input?.headRefName === 'string' ? input.headRefName : '';
      const title = typeof input?.title === 'string' ? input.title : '';
      const body = typeof input?.body === 'string' ? input.body : '';
      const pull = store.createPull(repo, title, body, headRefName, baseRefName);
      return { __type: 'CreatePullRequestPayload', repo, pull };
    }
    case 'mergePullRequest': {
      const input = args.input as Record<string, unknown> | undefined;
      const found = input && typeof input.pullRequestId === 'string' ? findPullByGid(store, input.pullRequestId) : null;
      if (!found) throw new Error('mergePullRequest: pull request not found');
      const headTip = store.branchCommit(found.repo, found.pull.head.ref);
      const baseTip = store.branchCommit(found.repo, found.pull.base.ref);
      if (!headTip || !baseTip) throw new Error('mergePullRequest: head or base branch missing');
      if (store.hasMergeConflict(found.repo, headTip, baseTip)) throw new Error('mergePullRequest: merge conflict');
      store.squashMerge(found.repo, found.pull);
      return { __type: 'MergePullRequestPayload', repo: found.repo, pull: found.pull };
    }
    case 'addComment': {
      const input = args.input as Record<string, unknown> | undefined;
      const body = typeof input?.body === 'string' ? input.body : '';
      const subjectId = typeof input?.subjectId === 'string' ? input.subjectId : '';
      const issue = findIssueByGid(store, subjectId);
      if (issue) {
        const now = store.clock.nowIso();
        const comment = { id: store.allocateId(), body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: now, updated_at: now };
        issue.issue.comments.push(comment);
        return { __type: 'AddCommentPayload', repo: issue.repo, issueNumber: issue.issue.number, comment: { id: comment.id, body } };
      }
      const pull = findPullByGid(store, subjectId);
      if (pull) {
        const now = store.clock.nowIso();
        const comment = { id: store.allocateId(), body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: now, updated_at: now };
        pull.pull.comments.push(comment);
        return { __type: 'AddCommentPayload', repo: pull.repo, issueNumber: pull.pull.number, comment: { id: comment.id, body } };
      }
      throw new Error('addComment: subject not found');
    }
    default:
      return undefined;
  }
}

const ROOT_FIELDS = new Set(['viewer', 'repository', 'node', '__type', '__schema', 'createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']);

export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>): GraphQLExecution {
  const ctx: Ctx = { store, errors: [] };
  let operations: OperationNode[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'GraphQL parse error' }] };
  }
  const operation = operations[0]!;
  const data: Record<string, unknown> = {};
  for (const selection of operation.selectionSet) {
    if (selection.kind === 'inlineFragment') continue;
    const field = selection.field;
    const responseName = field.alias ?? field.name;
    if (!ROOT_FIELDS.has(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
      continue;
    }
    let value: AnyObject | null | undefined;
    try {
      value = resolveRootField(ctx, field, variables);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : 'field resolution failed' });
      continue;
    }
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
      continue;
    }
    if (value === null) {
      data[responseName] = null;
      continue;
    }
    data[responseName] = field.selectionSet.length === 0 ? value : executeSelectionSet(ctx, value, field.selectionSet, variables);
  }
  const result: GraphQLExecution = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}
