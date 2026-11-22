// main.ts is mend, the CLI SPEC.md specifies: it applies an edit an AI model wrote, in one of four formats
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), to a tree of text files, all or nothing.
// The kit's starter did sections 1 to 4, 9 and 10 (command line, output and exit codes, safe paths, format
// detection, JSON edits, the all-or-nothing write); this file adds the rest: matching lines at three tiers
// (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), and the
// `R old -> new` output line for a move (section 2). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file split into lines (SPEC.md section 3): its own line break, and whether it ends with one. */
interface Split {
  lines: string[];
  br: string;
  final: boolean;
}
function splitFile(text: string): Split {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function joinFile(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, in order, for the `R old -> new` output line. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- section 5: matching lines ----

/** One line of a hunk, block or chunk body: a context line, an old line, or a new line. */
interface Op {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line (as in `\ No newline at end of file`) followed this body line. */
  noNl?: boolean;
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in lines at one tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const no = o.map((l) => normLine(l, tier));
  const nLines = lines.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (nLines[i + j] !== no[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with every occurrence at that tier. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function indentOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/**
 * Replace O (oLen lines) at position `at` with the lines the ops build: a context line is written as the
 * file's own matched line, never the patch's; at tier 2 every other line of N that starts with P (the
 * leading spaces and tabs of O's first line) has that P replaced by F (those of the file's first matched
 * line). Lines of N that are empty or only whitespace are written as they are.
 */
function spliceOps(lines: string[], at: number, ops: Op[], oLen: number, tier: number): string[] {
  const out = lines.slice(0, at);
  let oi = 0;
  let f = '';
  let p = '';
  if (tier === 2 && oLen > 0) {
    f = indentOf(lines[at] ?? '');
    const firstO = ops.find((o) => o.kind !== 'new');
    p = firstO ? indentOf(firstO.text) : '';
  }
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(lines[at + oi]!);
      oi += 1;
    } else if (op.kind === 'old') {
      oi += 1;
    } else {
      let t = op.text;
      if (tier === 2 && oLen > 0 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  out.push(...lines.slice(at + oLen));
  return out;
}

// ---- section 9: JSON edits (from the kit's starter) ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- section 6: unified diffs ----

interface Hunk {
  /** A from the hunk header `@@ -A[,B] +C[,D] @@`: the 1-based old start line. */
  a: number;
  ops: Op[];
}

interface Section {
  /** undefined: unnamed; null: `/dev/null` (no file). */
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  gitOld?: string;
  gitNew?: string;
  renameFrom?: string;
  renameTo?: string;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
  headerPaired: boolean;
}

/** The path a `--- ` or `+++ ` line names: after the four characters, up to the first tab, trimmed. */
function diffPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Apply a section's hunks in order to a file's text, each to the result of the ones before it. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let { lines, br, final } = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const oLen = h.ops.filter((o) => o.kind !== 'new').length;
    const nLen = h.ops.filter((o) => o.kind !== 'old').length;
    const lastN = [...h.ops].reverse().find((o) => o.kind !== 'old');
    const lastNoNl = lastN ? !!lastN.noNl : false;
    if (oLen === 0) {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = at === lines.length;
      const ins = h.ops.filter((o) => o.kind === 'new').map((o) => o.text);
      lines.splice(at, 0, ...ins);
      if (atEnd) final = !lastNoNl;
      d += nLen;
    } else {
      const o = h.ops.filter((op) => op.kind !== 'new').map((op) => op.text);
      const found = findTier(lines, o, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      for (const pos of found.occ) {
        if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      }
      const touchesEnd = best + oLen === lines.length;
      lines = spliceOps(lines, best, h.ops, oLen, found.tier);
      if (touchesEnd) final = !lastNoNl;
      d += nLen - oLen;
    }
  }
  return joinFile(lines, br, final);
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath !== undefined ? sec.oldPath : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
    const newP = sec.newPath !== undefined ? sec.newPath : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
    if (oldP === null || sec.create) {
      // Creation: the new path does not exist; the file is the `+` lines of all its hunks.
      if (newP === null || newP === undefined) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const made: string[] = [];
      let lastPlusNoNl = false;
      for (const h of sec.hunks) {
        for (const op of h.ops) {
          if (op.kind === 'new') {
            made.push(op.text);
            lastPlusNoNl = !!op.noNl;
          }
        }
      }
      tree.now.set(newP, joinFile(made, '\n', made.length > 0 && !lastPlusNoNl));
      return;
    }
    if (newP === null || sec.del) {
      // Deletion: the old path exists; its hunks are not read.
      const op = oldP as string;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const oldPath = oldP as string;
    const newPath = newP as string;
    if (oldPath !== newPath) {
      // Move: the hunks apply to the old file's lines; the result is written at the new path.
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const cur = tree.get(oldPath);
      if (cur === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const out = applyHunks(cur, sec.hunks, strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, out);
      tree.moves.push([oldPath, newPath]);
      return;
    }
    // Change of the one path.
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const cur = tree.get(oldPath);
    if (cur === null) throw new Fail('missing', oldPath);
    tree.now.set(oldPath, applyHunks(cur, sec.hunks, strict, oldPath));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const gitRe = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const n = lines.length;
  const sections: Section[] = [];
  let i = 0;
  const startsPair = (j: number): boolean => lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  while (i < n) {
    const line = lines[i]!;
    let sec: Section;
    if (line.startsWith('diff --git ')) {
      const m = gitRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      sec = { oldPath: undefined, newPath: undefined, gitOld: m[1], gitNew: m[2], create: false, del: false, hunks: [], headerPaired: false };
      i += 1;
    } else if (startsPair(i)) {
      sec = { oldPath: undefined, newPath: undefined, create: false, del: false, hunks: [], headerPaired: false };
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
      continue;
    }
    // The section's header: up to its first hunk.
    while (i < n) {
      const h = lines[i]!;
      if (h.startsWith('diff --git ')) break;
      if (startsPair(i)) {
        if (sec.headerPaired) break;
        sec.oldPath = diffPath(h);
        sec.newPath = diffPath(lines[i + 1]!);
        sec.headerPaired = true;
        i += 2;
        continue;
      }
      if (h.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (h.startsWith('@@')) {
        if (!hunkRe.test(h)) throw new Exit2(`error: parse ${i + 1}`);
        break;
      }
      if (h.startsWith('rename from ')) {
        sec.renameFrom = h.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (h.startsWith('rename to ')) {
        sec.renameTo = h.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (h.startsWith('new file mode')) {
        sec.create = true;
        i += 1;
        continue;
      }
      if (h.startsWith('deleted file mode')) {
        sec.del = true;
        i += 1;
        continue;
      }
      i += 1;
    }
    // The section's hunks.
    while (i < n) {
      const h = lines[i]!;
      if (h.startsWith('diff --git ')) break;
      if (startsPair(i)) break;
      if (h.startsWith('@@')) {
        const hm = hunkRe.exec(h);
        if (!hm) throw new Exit2(`error: parse ${i + 1}`);
        const a = parseInt(hm[1]!, 10);
        i += 1;
        const ops: Op[] = [];
        while (i < n) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ')) break;
          if (startsPair(i)) break;
          if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
            if (b.startsWith('\\')) {
              const prev = ops[ops.length - 1];
              if (prev) prev.noNl = true;
              i += 1;
              continue;
            }
            if (b === '') ops.push({ kind: 'ctx', text: '' });
            else if (b.startsWith(' ')) ops.push({ kind: 'ctx', text: b.slice(1) });
            else if (b.startsWith('-')) ops.push({ kind: 'old', text: b.slice(1) });
            else ops.push({ kind: 'new', text: b.slice(1) });
            i += 1;
            continue;
          }
          break;
        }
        while (ops.length > 0) {
          const last = ops[ops.length - 1]!;
          if (last.kind === 'ctx' && last.text === '') ops.pop();
          else break;
        }
        sec.hunks.push({ a, ops });
        continue;
      }
      i += 1;
    }
    sections.push(sec);
  }
  return sections.map((s) => sectionEdit(s, strict));
}

// ---- section 7: SEARCH/REPLACE blocks ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile(newLines, '\n', newLines.length > 0));
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const { lines, br, final } = splitFile(cur);
    const found = findTier(lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const ops: Op[] = [
      ...oldLines.map((t): Op => ({ kind: 'old', text: t })),
      ...newLines.map((t): Op => ({ kind: 'new', text: t })),
    ];
    tree.now.set(path, joinFile(spliceOps(lines, found.occ[0]!, ops, oldLines.length, found.tier), br, final));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const isSearch = (l: string): boolean => l.trimEnd() === '<<<<<<< SEARCH';
  const isSep = (l: string): boolean => l.trimEnd() === '=======';
  const isReplace = (l: string): boolean => l.trimEnd() === '>>>>>>> REPLACE';
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < n) {
    if (!isSearch(lines[i]!)) {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let sepIdx = -1;
    let repIdx = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      if (isSearch(lines[j]!)) break;
      if (sepIdx < 0 && isSep(lines[j]!)) {
        sepIdx = j;
        continue;
      }
      if (sepIdx >= 0 && isReplace(lines[j]!)) {
        repIdx = j;
        break;
      }
    }
    if (sepIdx < 0 || repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, sepIdx), lines.slice(sepIdx + 1, repIdx), strict));
    prevPath = path;
    prevEnd = repIdx + 1;
    i = repIdx + 1;
  }
  return edits;
}

// ---- section 8: V4A patches ----

interface VChunk {
  /** null: no anchor. */
  anchor: string | null;
  ops: Op[];
  /** A `*** End of File` line ended this chunk: it anchors to the end of the file. */
  eof: boolean;
}

/** The first line at or after `from` equal to the anchor, at the first tier where one is; -1 when none. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const na = normLine(anchor, t);
    const nLines = lines.map((l) => normLine(l, t));
    for (let j = from; j < lines.length; j++) {
      if (nLines[j] === na) return j;
    }
  }
  return -1;
}

/** The first occurrence of O at or after `from`, at the first tier with one. */
function findTierFrom(lines: string[], o: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t).filter((p) => p >= from);
    if (eof) {
      const e = occ.filter((p) => p + o.length === lines.length);
      if (e.length > 0) return { tier: t, pos: e[0]! };
    } else if (occ.length > 0) {
      return { tier: t, pos: occ[0]! };
    }
  }
  return null;
}

function v4aAdd(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, joinFile(fileLines, '\n', fileLines.length > 0));
  };
}

function v4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdate(path: string, body: string[], secLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
    moveTo = body[0]!.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  const closeChunk = (): void => {
    if (cur) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (; idx < body.length; idx++) {
    const b = body[idx]!;
    if (b.startsWith('@@')) {
      closeChunk();
      const anchor = b.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, ops: [], eof: false };
      continue;
    }
    if (b === '*** End of File') {
      if (!cur) throw new Exit2(`error: parse ${secLine + 1 + idx}`);
      cur.eof = true;
      closeChunk();
      continue;
    }
    if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
      if (!cur) cur = { anchor: null, ops: [], eof: false };
      if (b === '') cur.ops.push({ kind: 'ctx', text: '' });
      else if (b.startsWith(' ')) cur.ops.push({ kind: 'ctx', text: b.slice(1) });
      else if (b.startsWith('-')) cur.ops.push({ kind: 'old', text: b.slice(1) });
      else cur.ops.push({ kind: 'new', text: b.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${secLine + 1 + idx}`);
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let { lines, br, final } = splitFile(curText);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(lines, ch.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const oLen = ch.ops.filter((o) => o.kind !== 'new').length;
      const nLen = ch.ops.filter((o) => o.kind !== 'old').length;
      if (oLen === 0) {
        const ins = ch.ops.filter((o) => o.kind === 'new').map((o) => o.text);
        const at = ch.eof ? lines.length : cursor;
        lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
      } else {
        const o = ch.ops.filter((op) => op.kind !== 'new').map((op) => op.text);
        const found = findTierFrom(lines, o, cursor, strict, ch.eof);
        if (!found) throw new Fail('no-match', path);
        lines = spliceOps(lines, found.pos, ch.ops, oLen, found.tier);
        cursor = found.pos + nLen;
      }
    }
    const out = joinFile(lines, br, final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'del' | 'upd';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'upd';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const secLine = i + 1;
    i += 1;
    const body: string[] = [];
    while (i < last) {
      const b = lines[i]!;
      if (isSectionStart(b)) break;
      body.push(b);
      i += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let j = 0; j < body.length; j++) {
        const b = body[j]!;
        if (b === '') fileLines.push('');
        else if (b.startsWith('+')) fileLines.push(b.slice(1));
        else throw new Exit2(`error: parse ${secLine + 1 + j}`);
      }
      edits.push(v4aAdd(path, fileLines));
    } else if (kind === 'del') {
      if (body.length > 0) throw new Exit2(`error: parse ${secLine + 1}`);
      edits.push(v4aDelete(path));
    } else {
      edits.push(v4aUpdate(path, body, secLine, strict));
    }
  }
  return edits;
}

// ---- section 1, 2 and 10: the command line, the output and the all-or-nothing write ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
