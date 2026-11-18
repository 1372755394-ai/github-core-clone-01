// Smart-HTTP git protocol: upload-pack v2/v0, receive-pack v0.
// pkt-line framing, advertisements, ls-refs, fetch (incl. shallow/deepen), push.

import {
  ZERO_OID,
  collectCommitsDepth,
  collectReachable,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObject,
} from './gitobj.ts';
import type { Repo, Store } from './store.ts';

export const AGENT = 'makefun-forge/1.0';

export function pktLine(payload: string | Buffer): Buffer {
  const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = bytes.length + 4;
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), bytes]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Split sideband band-1 packets (max 65516 payload bytes each, band byte included). */
export function sidebandData(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const maxPayload = 65516;
  let offset = 0;
  if (data.length === 0) {
    parts.push(pktLine('\x01'));
    return Buffer.concat(parts);
  }
  while (offset < data.length) {
    const chunk = data.subarray(offset, offset + maxPayload - 1);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    offset += chunk.length;
  }
  return Buffer.concat(parts);
}

export interface PktRequest {
  lines: string[]; // decoded text lines (without trailing \n), up to the first flush
  rest: Buffer; // everything after the first flush packet
}

/** Parse pkt-lines until the first flush. Throws on a malformed length prefix. */
export function parsePktRequest(body: Buffer): PktRequest {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const lengthHex = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lengthHex)) throw new Error(`bad pkt-line length ${JSON.stringify(lengthHex)}`);
    const length = parseInt(lengthHex, 16);
    if (length === 0) {
      return { lines, rest: body.subarray(offset + 4) };
    }
    if (length === 1) {
      // delim packet: record as a marker line and continue
      lines.push('\u0001');
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) throw new Error('pkt-line is truncated');
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    lines.push(payload.endsWith('\n') ? payload.slice(0, -1) : payload);
    offset += length;
  }
  throw new Error('pkt-line stream ends without a flush');
}

// -- advertisements -----------------------------------------------------------

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** All refs in advertisement order: HEAD first, then refs sorted, peeled tags after their tag. */
export function advertisedRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.default_branch}`);
  if (tip) out.push({ oid: tip, name: 'HEAD' });
  const names = [...repo.refs.keys()].filter((name) => name !== 'HEAD').sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    out.push({ oid, name });
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') {
        const target = parseTag(object.data).object;
        const peeled = repo.objects.get(target)?.type === 'commit' ? target : undefined;
        if (peeled) out.push({ oid: peeled, name: `${name}^{}` });
      }
    }
  }
  return out;
}

export function uploadPackAdvertisementV2(): Buffer {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
}

/** The v2 capability advertisement never varies: one shared buffer, not one per request. */
export const V2_ADVERTISEMENT = uploadPackAdvertisementV2();

// -- response caches -----------------------------------------------------------
// Git objects are immutable and a fetch selection is a pure function of (wants, haves,
// depth, shallow boundaries) once every named object exists, so a complete selection's
// whole response can be reused; advertisements and ls-refs listings are pure functions
// of the ref set, keyed on the repo's refsVersion (bumped on every ref write).
const CACHE_MAX = 32;
function cachePut<K, V>(cache: Map<K, V>, key: K, value: V): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}
const advertisementCache = new Map<string, Buffer>();
const lsRefsCache = new Map<string, Buffer>();
const fetchResponseCache = new Map<string, Buffer>();

export function cachedAdvertisementV0(repo: Repo, service: 'upload' | 'receive'): Buffer {
  // objects.size too: a tag's peeled line appears when its target object arrives, which
  // can happen on a push whose ref update fails (no ref write, so no refsVersion bump).
  const key = `${service}|${repo.id}|${repo.refsVersion}|${repo.objects.size}`;
  const hit = advertisementCache.get(key);
  if (hit) return hit;
  const value = service === 'upload' ? uploadPackAdvertisementV0(repo) : receivePackAdvertisementV0(repo);
  cachePut(advertisementCache, key, value);
  return value;
}

export function uploadPackAdvertisementV0(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktFlush()];
  const refs = advertisedRefs(repo);
  const caps = `symref=HEAD:refs/heads/${repo.default_branch} side-band-64k ofs-delta thin-pack shallow agent=${AGENT}`;
  if (refs.length === 0) {
    // No refs yet: advertise capabilities on the capabilities^{} line, as git does.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  }
  refs.forEach((ref, index) => {
    const suffix = index === 0 ? `\0${caps}` : '';
    parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
  });
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function receivePackAdvertisementV0(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), pktFlush()];
  const refs = advertisedRefs(repo);
  const caps = 'report-status side-band-64k delete-refs ofs-delta agent=' + AGENT;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  }
  refs.forEach((ref, index) => {
    const suffix = index === 0 ? `\0${caps}` : '';
    parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
  });
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// -- upload-pack ---------------------------------------------------------------

interface FetchSelection {
  commits: Set<string>; // commits to include
  boundary: Set<string>; // shallow boundary commits
  unshallow: Set<string>; // previously-shallow commits now fully included
  objects: Map<string, GitObject>; // objects to pack
  /** True when every want and have named an object the store holds: only then is the pack
   * a pure function of the key (a later push cannot change what this selection means). */
  complete: boolean;
}

// Pack bytes are a pure function of (repo, wants, depth, haves): git objects are immutable, and
// the reachable set from fixed oids never changes as the store grows. Cache the serialized pack
// (the clone workload fetches the same depth-1 pack fifty times in a row).
const PACK_CACHE_MAX = 16;
const packCache = new Map<string, Buffer>();

function packCacheKey(repo: Repo, wants: string[], haves: string[], depth: number | null): string {
  return `${repo.id}|${[...wants].sort().join(',')}|${depth ?? ''}|${[...haves].sort().join(',')}`;
}

export function cachedPack(repo: Repo, wants: string[], haves: string[], depth: number | null, selection: FetchSelection): Buffer {
  if (!selection.complete) return writePack(selection.objects.values());
  const key = packCacheKey(repo, wants, haves, depth);
  const hit = packCache.get(key);
  if (hit) return hit;
  const pack = writePack(selection.objects.values());
  if (packCache.size >= PACK_CACHE_MAX) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, pack);
  return pack;
}

function collectHaveReachable(haves: Iterable<string>, stopAt: Set<string>, lookup: ObjectLookup): Set<string> {
  // Everything the client already holds. A shallow boundary commit is held itself (with its
  // tree), but the client does not hold that commit's parents: traversal stops there.
  const seen = new Set<string>();
  const queue = [...haves];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!stopAt.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

function selectFetchObjects(store: Store, repo: Repo, wants: string[], haves: string[], depth: number | null, shallowBoundaries: string[]): FetchSelection {
  const lookup = store.lookup(repo);
  const wantCommits: string[] = [];
  const wantTags: string[] = [];
  let complete = true;
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (!object) {
      complete = false;
      continue;
    }
    if (object.type === 'commit') wantCommits.push(want);
    else if (object.type === 'tag') {
      wantTags.push(want);
      const peeled = store.peelToCommit(repo, want);
      if (peeled) wantCommits.push(peeled);
    }
  }
  for (const have of haves) {
    if (!repo.objects.has(have)) complete = false;
  }
  let commits: Set<string>;
  let boundary = new Set<string>();
  if (depth !== null) {
    commits = collectCommitsDepth(wantCommits, depth, lookup);
    // Boundary = included commits whose parents exist but are not included.
    for (const commit of commits) {
      const object = repo.objects.get(commit);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!commits.has(parent) && repo.objects.has(parent)) {
          boundary.add(commit);
          break;
        }
      }
    }
  } else {
    commits = collectReachable(wantCommits, lookup, { allowMissing: true });
    // Keep only commits (reachable includes trees/blobs); recompute commit set.
    const commitSet = new Set<string>();
    const queue = [...wantCommits];
    const seen = new Set<string>();
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      commitSet.add(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    commits = commitSet;
  }
  // Exclude anything reachable from the haves (stopping at the client's shallow boundaries).
  const haveReachable = haves.length ? collectHaveReachable(haves, new Set(shallowBoundaries), lookup) : new Set<string>();
  const unshallow = new Set<string>();
  for (const old of shallowBoundaries) {
    if (commits.has(old) && !boundary.has(old)) unshallow.add(old);
  }
  const keptCommits = new Set([...commits].filter((oid) => !haveReachable.has(oid)));
  boundary = new Set([...boundary].filter((oid) => keptCommits.has(oid)));
  // Objects: each kept commit plus its own tree/blobs only (never a parent's objects, so a
  // depth-limited fetch really stops at the boundary), plus any wanted tag objects.
  const objects = new Map<string, GitObject>();
  const addTree = (treeOid: string): void => {
    const queue = [treeOid];
    const seenTrees = new Set<string>();
    while (queue.length) {
      const current = queue.pop()!;
      if (seenTrees.has(current)) continue;
      seenTrees.add(current);
      const tree = repo.objects.get(current);
      if (!tree || tree.type !== 'tree') continue;
      if (!haveReachable.has(current)) objects.set(current, tree);
      for (const entry of parseTree(tree.data)) {
        if (entry.mode === '40000') {
          queue.push(entry.oid);
        } else if (entry.mode !== '160000') {
          const blob = repo.objects.get(entry.oid);
          if (blob && !haveReachable.has(entry.oid)) objects.set(entry.oid, blob);
        }
      }
    }
  };
  for (const oid of keptCommits) {
    const commit = repo.objects.get(oid);
    if (!commit || commit.type !== 'commit') continue;
    if (!haveReachable.has(oid)) objects.set(oid, commit);
    addTree(parseCommit(commit.data).tree);
  }
  for (const tagOid of wantTags) {
    const tag = repo.objects.get(tagOid);
    if (tag && !haveReachable.has(tagOid)) objects.set(tagOid, tag);
  }
  return { commits: keptCommits, boundary, unshallow, objects, complete };
}

export function handleUploadPackV2(store: Store, repo: Repo, body: Buffer): Buffer {
  const { lines } = parsePktRequest(body);
  const delimIndex = lines.indexOf('\u0001');
  const headerLines = delimIndex >= 0 ? lines.slice(0, delimIndex) : lines;
  const argLines = delimIndex >= 0 ? lines.slice(delimIndex + 1) : [];
  const commandLine = headerLines.find((line) => line.startsWith('command='));
  const command = commandLine ? commandLine.slice('command='.length) : '';
  if (command === 'ls-refs') return handleLsRefs(repo, argLines);
  if (command === 'fetch') return handleFetchV2(store, repo, argLines);
  throw new Error(`unsupported upload-pack command ${JSON.stringify(command)}`);
}

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  // objects.size too: peeled tag lines depend on target objects existing (see above).
  const cacheKey = `${repo.id}|${repo.refsVersion}|${repo.objects.size}|${args.join('\n')}`;
  const cached = lsRefsCache.get(cacheKey);
  if (cached) return cached;
  const built = buildLsRefs(repo, args);
  cachePut(lsRefsCache, cacheKey, built);
  return built;
}

function buildLsRefs(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const refs = advertisedRefs(repo);
  const hasCommits = refs.some((ref) => ref.name !== 'HEAD' || ref.oid !== ZERO_OID);
  if (!hasCommits && unborn) {
    // Empty repository: only the unborn HEAD line.
    if (keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.default_branch}\n`));
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (ref.name === 'HEAD' && symrefs) line += ` symref-target:refs/heads/${repo.default_branch}`;
    if (peel && ref.name.startsWith('refs/tags/')) {
      const object = repo.objects.get(ref.oid);
      if (object?.type === 'tag') {
        const peeled = parseTag(object.data).object;
        if (repo.objects.get(peeled)?.type === 'commit') line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleFetchV2(store: Store, repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowBoundaries.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const parsed = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) depth = parsed;
    }
    // deepen-since / deepen-not / filter / thin-pack / no-progress / ofs-delta: accepted, ignored.
  }
  const cacheKey = `v2|${packCacheKey(repo, wants, haves, depth)}|${[...shallowBoundaries].sort().join(',')}`;
  const cachedResponse = fetchResponseCache.get(cacheKey);
  if (cachedResponse) return cachedResponse;
  const selection = selectFetchObjects(store, repo, wants, haves, depth, shallowBoundaries);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  const knownHave = haves.find((have) => repo.objects.has(have));
  if (knownHave) {
    parts.push(pktLine(`ACK ${knownHave}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktDelim());
  // shallow-info
  if (depth !== null || shallowBoundaries.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of [...selection.boundary].sort()) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of [...selection.unshallow].sort()) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  // packfile
  parts.push(pktLine('packfile\n'));
  const pack = cachedPack(repo, wants, haves, depth, selection);
  parts.push(sidebandData(pack));
  parts.push(pktFlush());
  const out = Buffer.concat(parts);
  // A complete selection's response is a pure function of the cached key (git objects are
  // immutable and only ever added), so the 50 concurrent clones share one built response.
  if (selection.complete && out.length < 1024 * 1024) cachePut(fetchResponseCache, cacheKey, out);
  return out;
}

export function handleUploadPackV0(store: Store, repo: Repo, body: Buffer): Buffer {
  // Two sections: wants (flush), then haves + done (flush). The second section may be absent.
  const first = parsePktRequest(body);
  const second = first.rest.length > 0 ? parsePktRequest(first.rest) : { lines: [], rest: Buffer.alloc(0) };
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  for (const line of first.lines) {
    const clean = line.includes('\0') ? line.slice(0, line.indexOf('\0')) : line;
    if (clean.startsWith('want ')) wants.push(clean.slice(5).split(' ')[0]!);
    else if (clean.startsWith('shallow ')) shallowBoundaries.push(clean.slice(8).trim());
    else if (clean.startsWith('deepen ')) {
      const parsed = Number.parseInt(clean.slice(7).trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) depth = parsed;
    }
  }
  for (const line of second.lines) {
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  const selection = selectFetchObjects(store, repo, wants, haves, depth, shallowBoundaries);
  const parts: Buffer[] = [];
  const knownHave = haves.find((have) => repo.objects.has(have));
  if (knownHave) parts.push(pktLine(`ACK ${knownHave}\n`));
  else parts.push(pktLine('NAK\n'));
  for (const oid of [...selection.boundary].sort()) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of [...selection.unshallow].sort()) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = cachedPack(repo, wants, haves, depth, selection);
  parts.push(sidebandData(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// -- receive-pack --------------------------------------------------------------

export interface PushOutcome {
  unpackOk: boolean;
  unpackDetail: string;
  results: Array<{ ref: string; ok: boolean; reason: string }>;
}

export function handleReceivePack(store: Store, repo: Repo, body: Buffer): { status: number; body: Buffer; unpackOk: boolean } {
  const parsed = parsePktRequest(body);
  const packBytes = parsed.rest;
  interface Command { oldOid: string; newOid: string; ref: string }
  const commands: Command[] = [];
  for (const line of parsed.lines) {
    const clean = line.includes('\0') ? line.slice(0, line.indexOf('\0')) : line;
    const parts = clean.split(' ');
    if (parts.length !== 3) return badReport('bad command line');
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) return badReport('bad command');
    commands.push({ oldOid, newOid, ref });
  }
  // Validate the pack before touching any ref (unpack ok even for refused refs).
  if (packBytes.length > 0) {
    if (packBytes.length < 32) return badReport('pack too small');
    const checksum = verifyPackChecksum(packBytes);
    if (!checksum.ok) return badReport('pack checksum mismatch');
    let parsedPack;
    try {
      parsedPack = readPack(packBytes, { resolveBase: store.lookup(repo) });
    } catch (error) {
      return badReport(`unpack error: ${error instanceof Error ? error.message : 'bad pack'}`);
    }
    // readPack already keys every object by hashObject(type, data): the oid IS the verified
    // hash, so re-hashing each object here was pure redundancy.
    for (const [oid, object] of parsedPack.objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // delete
      if (!current) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else {
        store.deleteRef(repo, command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (!current) {
      if (command.oldOid !== ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      store.setRef(repo, command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (command.newOid === current) {
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const ancestor = store.isAncestor(repo, current, command.newOid);
    if (!ancestor) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    store.setRef(repo, command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  repo.pushed_at = store.clock.nowIso();
  const reportLines = ['unpack ok\n'];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = Buffer.concat(reportLines.map((line) => pktLine(line)));
  const bodyOut = Buffer.concat([sidebandData(report), pktFlush()]);
  return { status: 200, body: bodyOut, unpackOk: true };

  function badReport(detail: string): { status: number; body: Buffer; unpackOk: boolean } {
    const report = pktLine(`unpack ${detail}\n`);
    return { status: 200, body: Buffer.concat([sidebandData(report), pktFlush()]), unpackOk: false };
  }
}

export { parseTree };
