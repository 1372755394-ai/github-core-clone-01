// Git object model, packfile read/write and reachability, stdlib only.
// Objects are stored verbatim: a pushed object's bytes are its identity.

import { createHash } from 'node:crypto';
import { inflateSync as zlibInflate, deflateSync as zlibDeflate } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes, entries sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Build a commit object's bytes. `who` is a full "Name <email> ts +0000" line. */
export function buildCommit(tree: string, parents: readonly string[], authorLine: string, committerLine: string, message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${authorLine}`, `committer ${committerLine}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

/** Every object reachable from `roots`. Throws on a missing object unless allowMissing. */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup, options: { allowMissing?: boolean } = {}): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Is `ancestor` an ancestor of (or equal to) `oid`? Walks commit parents only. */
export function isAncestor(ancestor: string, oid: string, lookup: ObjectLookup): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>();
  const queue = [oid];
  while (queue.length) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = lookup(current);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The merge-base of two commits: the newest common ancestor (by generation). */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const ancestorsA = new Map<string, number>();
  const queueA: Array<[string, number]> = [[a, 0]];
  while (queueA.length) {
    const [oid, depth] = queueA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.set(oid, depth);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push([parent, depth + 1]);
  }
  let best: string | null = null;
  let bestDepth = Infinity;
  const queueB: Array<[string, number]> = [[b, 0]];
  const seenB = new Set<string>();
  while (queueB.length) {
    const [oid, depth] = queueB.pop()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const depthA = ancestorsA.get(oid);
    if (depthA !== undefined) {
      const total = depthA + depth;
      if (total < bestDepth) {
        bestDepth = total;
        best = oid;
      }
    }
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push([parent, depth + 1]);
  }
  return best;
}

/** Commits reachable from `roots` within `depth` generations (depth 1 = the tips only). */
export function collectCommitsDepth(roots: Iterable<string>, depth: number, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  let frontier = [...roots].filter((oid) => isObjectId(oid));
  for (let level = 0; level < depth && frontier.length; level += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      seen.add(oid);
      for (const parent of parseCommit(object.data).parents) next.push(parent);
    }
    frontier = next;
  }
  return seen;
}

// --------------------------------------------------------------------------------------------
// packfile
// --------------------------------------------------------------------------------------------

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
  version: number;
  declaredCount: number;
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number } {
  let size = buffer[start]! & 0x0f;
  let shift = 4;
  let pos = start + 1;
  while (buffer[pos - 1]! & 0x80) {
    size |= (buffer[pos]! & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { size, next: pos };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { offset |= delta[pos]! << (8 * i); pos += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { size |= delta[pos]! << (8 * i); pos += 1; }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta op 0 is invalid');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== resultSize || produced !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

/** Parse a packfile, resolving deltas against the pack itself and `resolveBase`. */
export function readPack(pack: Buffer, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const pending: Array<{ type: GitObjectType; data: Buffer; baseOid?: string; baseOffset?: number; offset: number }> = [];
  let offset = 12;
  let deltaCount = 0;
  const byOffset = new Map<number, string>();
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const first = pack[offset]!;
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    offset += 1;
    while (pack[offset - 1]! & 0x80) {
      size |= (pack[offset]! & 0x7f) << shift;
      shift += 7;
      offset += 1;
    }
    if (typeCode === 6 || typeCode === 7) {
      deltaCount += 1;
      let baseOid: string | undefined;
      let baseOffset: number | undefined;
      if (typeCode === 6) {
        const byte0 = pack[offset]!;
        offset += 1;
        let base = byte0 & 0x7f;
        while (byte0 & 0x80) {
          const b = pack[offset]!;
          offset += 1;
          base = ((base + 1) << 7) | (b & 0x7f);
          if (!(b & 0x80)) break;
        }
        baseOffset = entryOffset - base;
      } else {
        baseOid = pack.subarray(offset, offset + 20).toString('hex');
        offset += 20;
      }
      const { data, next } = inflateWithLength(pack, offset);
      pending.push({ type: 'blob', data, baseOid, baseOffset, offset: entryOffset });
      offset = next;
    } else {
      const type = CODE_TYPE[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      const { data, next } = inflateWithLength(pack, offset);
      const oid = hashObject(type, data);
      objects.set(oid, { type, data });
      byOffset.set(entryOffset, oid);
      offset = next;
    }
  }
  // Resolve deltas (they may reference earlier pack entries or the store).
  for (const entry of pending) {
    let baseObj: GitObject | undefined;
    if (entry.baseOid !== undefined) {
      baseObj = objects.get(entry.baseOid) ?? options.resolveBase?.(entry.baseOid);
    } else if (entry.baseOffset !== undefined) {
      const baseOid = byOffset.get(entry.baseOffset);
      baseObj = baseOid !== undefined ? objects.get(baseOid) : undefined;
    }
    if (!baseObj) throw new Error('delta base object is missing');
    const data = applyDelta(baseObj.data, entry.data);
    // The delta's type is the base's type.
    const oid = hashObject(baseObj.type, data);
    objects.set(oid, { type: baseObj.type, data });
    byOffset.set(entry.offset, oid);
  }
  return { objects, deltaCount, version, declaredCount: count };
}

// One inflateSync call per object: with {info:true} the engine reports exactly how many
// input bytes the deflate stream consumed, so no probing is needed to find its end.
function inflateWithLength(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = zlibInflate(buffer.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return { ok: actual === expected, expected, actual };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(zlibDeflate(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
