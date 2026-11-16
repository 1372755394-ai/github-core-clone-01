// In-memory forge state. All timestamps come from a deterministic counter starting at
// the scenario epoch, so replayed trials export byte-identical state.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  avatar_url: 'https://example.invalid/avatars/adaiversen',
  html_url: 'https://example.invalid/adaiversen',
  type: 'User',
} as const;

export const TEAMMATE = { login: 'quinnkeller', id: 1001, name: 'quinn keller', email: 'quinnkeller@example.invalid' } as const;
export const STRANGER = { login: 'olgabauer', id: 1002, name: 'olga bauer', email: 'olgabauer@example.invalid' } as const;
export const ORG = { login: 'faint-meadow-org', id: 2000 } as const;
export const DEFAULT_BRANCH = 'main';

// Scenario epoch: 2025-01-01T00:00:00Z. Each timestamp request advances one second.
const EPOCH_MS = 1735689600000;

export class Clock {
  private seq = 0;
  nowMs(): number {
    const ms = EPOCH_MS + this.seq * 1000;
    this.seq += 1;
    return ms;
  }
  nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }
  /** "Name <email> <unix> +0000" ident line for commits, from the deterministic clock. */
  ident(login: string, name: string, email: string): string {
    const unix = Math.floor(this.nowMs() / 1000);
    return `${name} <${email}> ${unix} +0000`;
  }
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: IssueComment[];
  repoId: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
  comments: IssueComment[];
  repoId: number;
}

export interface Repo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string; id: number; type: string };
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string | null;
  has_issues: boolean;
  has_wiki: boolean;
  has_projects: boolean;
  forks_count: number;
  open_issues_count: number;
  watchers_count: number;
  stargazers_count: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // refname -> oid
  labels: Label[];
  issues: Issue[];
  pulls: PullRequest[];
  nextIssueNumber: number;
  nextPullNumber: number;
}

export interface RepoView {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string; id: number; type: string; avatar_url: string; html_url: string };
  description: string;
  private: boolean;
  fork: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string | null;
  html_url: string;
  clone_url: string;
  git_url: string;
  ssh_url: string;
  has_issues: boolean;
  has_wiki: boolean;
  has_projects: boolean;
  forks_count: number;
  open_issues_count: number;
  watchers_count: number;
  stargazers_count: number;
  license: { key: string; name: string; spdx_id: string } | null;
  topics: string[];
  visibility: string;
}

export class Store {
  readonly clock = new Clock();
  readonly repos = new Map<string, Repo>(); // key `${owner}/${name}`
  private nextRepoId = 1;
  private nextObjectId = 1; // global id for issues, comments, PRs, labels
  private nextLabelId = 1;

  /** Public id allocator for objects created outside the Store (issue comments). */
  allocateId(): number {
    return this.newId();
  }

  private newId(): number {
    const id = this.nextObjectId;
    this.nextObjectId += 1;
    return id;
  }

  createRepo(ownerLogin: string, ownerId: number, name: string, options: { description?: string; private?: boolean } = {}): Repo {
    const key = `${ownerLogin}/${name}`;
    const now = this.clock.nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      full_name: key,
      owner: { login: ownerLogin, id: ownerId, type: 'User' },
      description: options.description ?? '',
      private: options.private ?? false,
      default_branch: DEFAULT_BRANCH,
      created_at: now,
      updated_at: now,
      pushed_at: null,
      has_issues: true,
      has_wiki: true,
      has_projects: true,
      forks_count: 0,
      open_issues_count: 0,
      watchers_count: 0,
      stargazers_count: 0,
      objects: new Map(),
      refs: new Map(),
      labels: this.defaultLabels(),
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  repoView(repo: Repo): RepoView {
    return {
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      owner: {
        login: repo.owner.login,
        id: repo.owner.id,
        type: repo.owner.type,
        avatar_url: `https://example.invalid/avatars/${repo.owner.login}`,
        html_url: `https://example.invalid/${repo.owner.login}`,
      },
      description: repo.description,
      private: repo.private,
      fork: false,
      default_branch: repo.default_branch,
      created_at: repo.created_at,
      updated_at: repo.updated_at,
      pushed_at: repo.pushed_at,
      html_url: `https://example.invalid/${repo.full_name}`,
      clone_url: `https://example.invalid/${repo.full_name}.git`,
      git_url: `git://example.invalid/${repo.full_name}.git`,
      ssh_url: `git@example.invalid:${repo.full_name}.git`,
      has_issues: repo.has_issues,
      has_wiki: repo.has_wiki,
      has_projects: repo.has_projects,
      forks_count: repo.forks_count,
      open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
      watchers_count: repo.watchers_count,
      stargazers_count: repo.stargazers_count,
      license: null,
      topics: [],
      visibility: repo.private ? 'private' : 'public',
    };
  }

  // -- git objects ---------------------------------------------------------

  storeObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  refTarget(repo: Repo, ref: string): string | null {
    if (ref === 'HEAD') {
      const head = repo.refs.get('HEAD');
      if (head && head.startsWith('ref: ')) return this.refTarget(repo, head.slice(5));
      return head ?? null;
    }
    return repo.refs.get(ref) ?? null;
  }

  /** Resolve a ref name, a branch name, a tag name, or a raw oid to an oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isObjectId(ref)) return repo.objects.has(ref) ? ref : null;
    const candidates = [
      `refs/heads/${ref}`,
      `refs/tags/${ref}`,
      ref,
      `refs/remotes/${ref}`,
    ];
    for (const candidate of candidates) {
      const target = this.refTarget(repo, candidate);
      if (target) return target;
    }
    return null;
  }

  headCommit(repo: Repo): string | null {
    return this.refTarget(repo, `refs/heads/${repo.default_branch}`);
  }

  /** The commit a branch ref points at, or null. */
  branchCommit(repo: Repo, branch: string): string | null {
    return this.refTarget(repo, `refs/heads/${branch}`);
  }

  /** Peel a ref: tag objects are followed to the commit they point at. */
  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = repo.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  // -- trees / files --------------------------------------------------------

  /** Flat map of path -> {mode, oid, size} for the tree at `commitOid`. */
  treeFiles(repo: Repo, commitOid: string): Map<string, { mode: string; oid: string; size: number }> {
    const out = new Map<string, { mode: string; oid: string; size: number }>();
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return out;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') {
          walk(entry.oid, path);
        } else if (entry.mode === '160000') {
          out.set(path, { mode: entry.mode, oid: entry.oid, size: 0 });
        } else {
          const blob = repo.objects.get(entry.oid);
          out.set(path, { mode: entry.mode, oid: entry.oid, size: blob?.data.length ?? 0 });
        }
      }
    };
    walk(parseCommit(commit.data).tree, '');
    return out;
  }

  /** Build a new tree by applying `changes` (path -> blob oid, null to delete) to `baseTreeOid`. */
  applyTreeChanges(repo: Repo, baseTreeOid: string | null, changes: Map<string, string | null>): string {
    // Represent the tree as nested maps.
    type Node = Map<string, { mode: string; oid: string } | Node>;
    const root: Node = new Map();
    const load = (treeOid: string | null, node: Node): void => {
      if (!treeOid) return;
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        if (entry.mode === '40000') {
          const child: Node = new Map();
          load(entry.oid, child);
          node.set(entry.name, child);
        } else {
          node.set(entry.name, { mode: entry.mode, oid: entry.oid });
        }
      }
    };
    load(baseTreeOid, root);
    for (const [path, oid] of changes) {
      const parts = path.split('/').filter((part) => part !== '');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i]!;
        const existing = node.get(part);
        if (existing instanceof Map) {
          node = existing;
        } else {
          const child: Node = new Map();
          node.set(part, child);
          node = child;
        }
      }
      const leaf = parts[parts.length - 1]!;
      if (oid === null) node.delete(leaf);
      else node.set(leaf, { mode: '100644', oid });
    }
    const writeTree = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node) {
        if (value instanceof Map) {
          if (value.size === 0) continue;
          entries.push({ mode: '40000', name, oid: writeTree(value) });
        } else {
          entries.push({ mode: value.mode, name, oid: value.oid });
        }
      }
      return this.storeObject(repo, 'tree', buildTree(entries));
    };
    return writeTree(root);
  }

  /** Create a commit on `branch` with `changes` over its current tip (or empty tree). */
  commitChanges(repo: Repo, branch: string, changes: Map<string, string | null>, message: string, committerLogin = VIEWER.login): string {
    const tip = this.branchCommit(repo, branch);
    const baseTree = tip ? parseCommit(repo.objects.get(tip)!.data).tree : null;
    const treeOid = this.applyTreeChanges(repo, baseTree, changes);
    const parents = tip ? [tip] : [];
    const author = this.clock.ident(VIEWER.name, VIEWER.name, VIEWER.email);
    const committer = this.clock.ident(VIEWER.name, VIEWER.name, VIEWER.email);
    void committerLogin;
    const commitData = buildCommit(treeOid, parents, author, committer, message);
    const commitOid = this.storeObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.pushed_at = this.clock.nowIso();
    return commitOid;
  }

  /** Diff between two commits: list of {path, status, additions, deletions, changes}. */
  diffCommits(repo: Repo, baseOid: string | null, headOid: string): Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> {
    const baseFiles = baseOid ? this.treeFiles(repo, baseOid) : new Map();
    const headFiles = this.treeFiles(repo, headOid);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      if (base && head && base.oid === head.oid) continue;
      let additions = 0;
      let deletions = 0;
      const countLines = (oid: string): number => {
        const blob = repo.objects.get(oid);
        if (!blob) return 0;
        const text = blob.data.toString('utf8');
        if (text.length === 0) return 0;
        return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      };
      if (!base && head) {
        additions = Math.max(1, countLines(head.oid));
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (base && !head) {
        deletions = Math.max(1, countLines(base.oid));
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (base && head) {
        const baseText = repo.objects.get(base.oid)?.data.toString('utf8') ?? '';
        const headText = repo.objects.get(head.oid)?.data.toString('utf8') ?? '';
        const baseLines = baseText === '' ? [] : baseText.split('\n');
        const headLines = headText === '' ? [] : headText.split('\n');
        const baseSet = new Set(baseLines);
        const headSet = new Set(headLines);
        additions = headLines.filter((line) => !baseSet.has(line)).length;
        deletions = baseLines.filter((line) => !headSet.has(line)).length;
        if (additions === 0 && deletions === 0) { additions = 1; deletions = 0; }
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** True when the two sides changed a common file differently since the merge-base. */
  hasMergeConflict(repo: Repo, headOid: string, baseOid: string): boolean {
    const base = mergeBase(headOid, baseOid, this.lookup(repo));
    const baseFiles = base ? this.treeFiles(repo, base) : new Map();
    const headFiles = this.treeFiles(repo, headOid);
    const baseFiles2 = this.treeFiles(repo, baseOid);
    for (const path of headFiles.keys()) {
      const head = headFiles.get(path)!;
      const atBase = baseFiles.get(path);
      const onBase = baseFiles2.get(path)!;
      if (!atBase) continue;
      if (onBase && onBase.oid !== atBase.oid && head.oid !== atBase.oid && head.oid !== onBase.oid) return true;
      if (!onBase && head.oid !== atBase.oid) return true;
    }
    return false;
  }

  // -- labels / issues / pulls ----------------------------------------------

  private defaultLabels(): Label[] {
    const defs: Array<[string, string, string]> = [
      ['bug', 'd73a4a', "Something isn't working"],
      ['enhancement', 'a2eeef', 'New feature or request'],
      ['documentation', '0075ca', 'Improvements or additions to documentation'],
      ['question', 'd876e3', 'Further information is requested'],
      ['good first issue', '7057ff', 'Good for newcomers'],
      ['help wanted', '008672', 'Extra attention is needed'],
    ];
    return defs.map(([name, color, description]) => this.makeLabel(name, color, description));
  }

  private makeLabel(name: string, color: string, description = ''): Label {
    const label: Label = { id: this.nextLabelId, name, color, description };
    this.nextLabelId += 1;
    return label;
  }

  ensureLabel(repo: Repo, name: string): Label {
    const existing = repo.labels.find((label) => label.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const label = this.makeLabel(name, 'd4c5f9');
    repo.labels.push(label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[] = []): Issue {
    const now = this.clock.nowIso();
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
      if (!label) throw new Error(`label not found: ${name}`);
      labels.push(label);
    }
    const issue: Issue = {
      id: this.newId(),
      number: repo.nextIssueNumber,
      title,
      body: body ?? '',
      state: 'open',
      labels,
      user: { login: VIEWER.login, id: VIEWER.id },
      created_at: now,
      updated_at: now,
      closed_at: null,
      comments: [],
      repoId: repo.id,
    };
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest {
    const now = this.clock.nowIso();
    const headSha = this.branchCommit(repo, headRef);
    const baseSha = this.branchCommit(repo, baseRef);
    if (!headSha || !baseSha) throw new Error('head or base branch does not exist');
    const pull: PullRequest = {
      id: this.newId(),
      number: repo.nextPullNumber,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergeable: null,
      merged_at: null,
      merge_commit_sha: null,
      head: { ref: headRef, sha: headSha },
      base: { ref: baseRef, sha: baseSha },
      user: { login: VIEWER.login, id: VIEWER.id },
      created_at: now,
      updated_at: now,
      comments: [],
      repoId: repo.id,
    };
    repo.nextPullNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /** Squash-merge a PR: one new commit on the base branch with the head's files. */
  squashMerge(repo: Repo, pull: PullRequest): string {
    const baseSha = this.branchCommit(repo, pull.base.ref);
    const headSha = this.branchCommit(repo, pull.head.ref);
    if (!baseSha || !headSha) throw new Error('head or base branch does not exist');
    const headFiles = this.treeFiles(repo, headSha);
    const baseFiles = this.treeFiles(repo, baseSha);
    const changes = new Map<string, string | null>();
    for (const [path, entry] of headFiles) changes.set(path, entry.oid);
    for (const path of baseFiles.keys()) if (!headFiles.has(path)) changes.set(path, null);
    const baseTree = parseCommit(repo.objects.get(baseSha)!.data).tree;
    const treeOid = this.applyTreeChanges(repo, baseTree, changes);
    const author = this.clock.ident(VIEWER.name, VIEWER.name, VIEWER.email);
    const committer = this.clock.ident(VIEWER.name, VIEWER.name, VIEWER.email);
    const message = `${pull.title} (#${pull.number})\n`;
    const commitData = buildCommit(treeOid, [baseSha], author, committer, message);
    const commitOid = this.storeObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.base.ref}`, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = this.clock.nowIso();
    pull.merge_commit_sha = commitOid;
    pull.updated_at = pull.merged_at;
    repo.pushed_at = pull.merged_at;
    return commitOid;
  }

  // -- reachability helpers ---------------------------------------------------

  reachableObjects(repo: Repo, tips: Iterable<string>): Set<string> {
    return collectReachable(tips, this.lookup(repo), { allowMissing: true });
  }

  isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
    return isAncestor(ancestor, oid, this.lookup(repo));
  }
}

/** Commit log: newest-first list of commits reachable from `tip`. */
export function commitLog(repo: Repo, tip: string, lookup: (oid: string) => GitObject | undefined): Array<{ sha: string; message: string; tree: string; parents: string[] }> {
  const out: Array<{ sha: string; message: string; tree: string; parents: string[] }> = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const parsed = parseCommit(object.data);
    out.push({ sha: oid, message: parsed.message, tree: parsed.tree, parents: parsed.parents });
    for (const parent of parsed.parents) queue.push(parent);
  }
  return out;
}

export { ZERO_OID };
