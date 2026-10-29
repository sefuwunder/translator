// ninep.ts — minimal 9P2000 file server + client, Bun + zero deps.
//
// This is the shared library for the executive-desk 9P surfaces (cadence,
// relay, outpost, translator). It is vendored verbatim into each repo so
// every app stays standalone; do not fork it per app.
//
// v1 scope, stated plainly:
// - No authentication: Tauth answers "no authentication required".
//   Run these servers on loopback only.
// - No Twstat: answers "not supported". Nothing in the desk needs it.
// - File writes replace the whole value and must start at offset 0.
//   There is no append semantics in v1.
// - Directories are served as stat streams, as 9P requires.
//
// Tree interface: an app supplies a root DirNode. Nodes are resolved
// fresh on every walk, so the tree always reflects the live database.

const Tversion = 100, Rversion = 101, Tauth = 102, Rauth = 103;
const Tattach = 104, Rattach = 105, Rerror = 107;
const Tflush = 108, Rflush = 109, Twalk = 110, Rwalk = 111;
const Topen = 112, Ropen = 113, Tcreate = 114, Rcreate = 115;
const Tread = 116, Rread = 117, Twrite = 118, Rwrite = 119;
const Tclunk = 120, Rclunk = 121, Tremove = 122, Rremove = 123;
const Tstat = 124, Rstat = 125, Twstat = 126;

const NOTAG = 0xffff;
const NOFID = 0xffffffff;
const DMDIR = 0x80000000;
const QTDIR = 0x80;
const QTFILE = 0x00;
const OTRUNC = 0x10;

export interface FileNode {
  kind: "file";
  name: string;
  path: string;
  len(): number;
  read(offset: number, count: number): Uint8Array;
  write?(offset: number, data: Uint8Array): number;
  truncate?(): void;
  remove?(): void;
  mtime(): number;
}

export interface DirNode {
  kind: "dir";
  name: string;
  path: string;
  list(): { name: string; isDir: boolean }[];
  get(name: string): Node | null;
  create?(name: string, isDir: boolean): Node;
  remove?(): void;
  mtime(): number;
}

export type Node = FileNode | DirNode;

// ---------- encoding helpers ----------

class Writer {
  bytes: number[] = [];
  u8(v: number) { this.bytes.push(v & 0xff); return this; }
  u16(v: number) { this.bytes.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v: number) {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
    return this;
  }
  u64(v: bigint) {
    for (let i = 0; i < 8; i++) this.bytes.push(Number((v >> BigInt(i * 8)) & 0xffn));
    return this;
  }
  str(s: string) {
    const b = new TextEncoder().encode(s);
    this.u16(b.length);
    for (const x of b) this.bytes.push(x);
    return this;
  }
  raw(b: Uint8Array) { for (const x of b) this.bytes.push(x); return this; }
  qid(q: { type: number; vers: number; path: bigint }) {
    return this.u8(q.type).u32(q.vers).u64(q.path);
  }
  buf(): Uint8Array { return new Uint8Array(this.bytes); }
}

class Reader {
  pos = 0;
  constructor(public b: Uint8Array) {}
  u8() { return this.b[this.pos++]; }
  u16() { const v = this.b[this.pos] | (this.b[this.pos + 1] << 8); this.pos += 2; return v; }
  u32() {
    const v = (this.b[this.pos] | (this.b[this.pos + 1] << 8) |
      (this.b[this.pos + 2] << 16) | (this.b[this.pos + 3] << 24)) >>> 0;
    this.pos += 4;
    return v;
  }
  u64() {
    let v = 0n;
    for (let i = 0; i < 8; i++) v |= BigInt(this.b[this.pos + i]) << BigInt(i * 8);
    this.pos += 8;
    return v;
  }
  str() {
    const n = this.u16();
    const s = new TextDecoder().decode(this.b.slice(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
  raw(n: number) { const s = this.b.slice(this.pos, this.pos + n); this.pos += n; return s; }
  qid() { return { type: this.u8(), vers: this.u32(), path: this.u64() }; }
}

function fnv(path: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const c of new TextEncoder().encode(path)) {
    h ^= BigInt(c);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

function qidFor(node: Node) {
  return { type: node.kind === "dir" ? QTDIR : QTFILE, vers: 0, path: fnv(node.path) };
}

function statOf(node: Node): Uint8Array {
  const w = new Writer();
  const name = node.name;
  const nameB = new TextEncoder().encode(name);
  const uid = new TextEncoder().encode("user");
  // size of everything after the size field itself
  const size = 2 + 4 + 13 + 4 + 4 + 4 + 8 + (2 + nameB.length) + (2 + uid.length) + (2 + uid.length) + 2;
  w.u16(size);
  w.u16(0); // type
  w.u32(0); // dev
  w.qid(qidFor(node));
  const mode = node.kind === "dir" ? (0o755 | DMDIR) : 0o644;
  w.u32(mode >>> 0);
  const mt = Math.floor(node.mtime() / 1000);
  w.u32(mt); // atime
  w.u32(mt); // mtime
  w.u64(BigInt(node.kind === "dir" ? 0 : node.len()));
  w.str(name);
  w.str("user"); // uid
  w.str("user"); // gid
  w.str(""); // muid
  return w.buf();
}

function msg(type: number, tag: number, body: Uint8Array): Uint8Array {
  const total = 7 + body.length;
  const w = new Writer();
  w.u32(total).u8(type).u16(tag).raw(body);
  return w.buf();
}

function rerror(tag: number, ename: string): Uint8Array {
  return msg(Rerror, tag, new Writer().str(ename).buf());
}

// ---------- server ----------

interface Fid { node: Node; opened: boolean }

export function serveNineP(root: DirNode, opts: { hostname?: string; port: number }) {
  const server = Bun.listen({
    hostname: opts.hostname || "127.0.0.1",
    port: opts.port,
    socket: {
      data(socket: any, data: Uint8Array) {
        const st = socket.data as { buf: Uint8Array; fids: Map<number, Fid>; msize: number };
        const next = new Uint8Array(st.buf.length + data.length);
        next.set(st.buf);
        next.set(data, st.buf.length);
        st.buf = next;
        while (st.buf.length >= 4) {
          const size = new DataView(st.buf.buffer, st.buf.byteOffset, 4).getUint32(0, true);
          if (size < 7 || size > 1024 * 1024) { socket.end(); return; }
          if (st.buf.length < size) break;
          const frame = st.buf.slice(0, size);
          st.buf = st.buf.slice(size);
          try {
            const out = dispatch(st, frame);
            if (out) socket.write(out);
          } catch (e: any) {
            // frame layout: size[4], type[1], tag[2] — tag is bytes 5-6.
            const tag = frame.length >= 7 ? (frame[5] | (frame[6] << 8)) : 0;
            socket.write(rerror(tag, String(e?.message || e)));
          }
        }
      },
      open(socket: any) {
        socket.data = { buf: new Uint8Array(0), fids: new Map(), msize: 8192 };
      },
      close() {},
      error() {},
    },
  });
  return server;

  function dispatch(st: { fids: Map<number, Fid>; msize: number }, frame: Uint8Array): Uint8Array | null {
    const r = new Reader(frame);
    r.u32(); // size
    const type = r.u8();
    const tag = r.u16();
    switch (type) {
      case Tversion: {
        const want = r.u32();
        r.str(); // version string, must be 9P2000; accept any
        st.msize = Math.min(want, 65536);
        const w = new Writer();
        w.u32(st.msize).str("9P2000");
        return msg(Rversion, tag, w.buf());
      }
      case Tauth:
        return rerror(tag, "no authentication required");
      case Tattach: {
        const fid = r.u32();
        const afid = r.u32();
        r.str(); r.str();
        if (afid !== NOFID) return rerror(tag, "unexpected afid");
        st.fids.set(fid, { node: root, opened: false });
        return msg(Rattach, tag, new Writer().qid(qidFor(root)).buf());
      }
      case Tflush: {
        r.u16();
        return msg(Rflush, tag, new Uint8Array(0));
      }
      case Twalk: {
        const fid = r.u32();
        const newfid = r.u32();
        const nwname = r.u16();
        const names: string[] = [];
        for (let i = 0; i < nwname; i++) names.push(r.str());
        const from = st.fids.get(fid);
        if (!from) return rerror(tag, "unknown fid");
        if (newfid !== fid && st.fids.has(newfid)) return rerror(tag, "fid in use");
        let node = from.node;
        const qids: { type: number; vers: number; path: bigint }[] = [];
        for (const name of names) {
          if (node.kind !== "dir") return rerror(tag, "not a directory");
          if (name === "..") return rerror(tag, "no parent walk");
          const next = node.get(name);
          if (!next) return rerror(tag, "file does not exist");
          node = next;
          qids.push(qidFor(node));
        }
        st.fids.set(newfid, { node, opened: false });
        const w = new Writer();
        w.u16(qids.length);
        for (const q of qids) w.qid(q);
        return msg(Rwalk, tag, w.buf());
      }
      case Topen: {
        const fid = r.u32();
        const mode = r.u8();
        const f = st.fids.get(fid);
        if (!f) return rerror(tag, "unknown fid");
        const wantWrite = (mode & 3) === 1 || (mode & 3) === 2;
        if (wantWrite) {
          if (f.node.kind !== "file" || !f.node.write) return rerror(tag, "permission denied");
        }
        if (mode & OTRUNC) {
          if (f.node.kind === "file" && f.node.truncate) f.node.truncate();
        }
        f.opened = true;
        const w = new Writer();
        w.qid(qidFor(f.node)).u32(0);
        return msg(Ropen, tag, w.buf());
      }
      case Tcreate: {
        const fid = r.u32();
        const name = r.str();
        const perm = r.u32();
        r.u8(); // mode
        const f = st.fids.get(fid);
        if (!f) return rerror(tag, "unknown fid");
        if (f.node.kind !== "dir" || !f.node.create) return rerror(tag, "permission denied");
        if (name === "" || name.includes("/")) return rerror(tag, "bad name");
        const node = f.node.create(name, (perm & DMDIR) !== 0);
        st.fids.set(fid, { node, opened: true });
        const w = new Writer();
        w.qid(qidFor(node)).u32(0);
        return msg(Rcreate, tag, w.buf());
      }
      case Tread: {
        const fid = r.u32();
        const offset = r.u64();
        const count = r.u32();
        const f = st.fids.get(fid);
        if (!f) return rerror(tag, "unknown fid");
        const max = Math.max(0, st.msize - 11);
        const n = Math.min(count, max);
        let data: Uint8Array;
        if (f.node.kind === "dir") {
          const parts: Uint8Array[] = [];
          for (const e of f.node.list()) {
            const child = f.node.get(e.name);
            if (child) parts.push(statOf(child));
          }
          const all = Buffer.concat(parts);
          data = all.slice(Number(offset), Number(offset) + n);
        } else {
          const all = f.node.read(Number(offset), n);
          data = all.slice(0, n);
        }
        const w = new Writer();
        w.u32(data.length).raw(data);
        return msg(Rread, tag, w.buf());
      }
      case Twrite: {
        const fid = r.u32();
        const offset = r.u64();
        const count = r.u32();
        const data = r.raw(count);
        const f = st.fids.get(fid);
        if (!f) return rerror(tag, "unknown fid");
        if (f.node.kind !== "file" || !f.node.write) return rerror(tag, "permission denied");
        if (offset !== 0n) return rerror(tag, "offset must be 0");
        const written = f.node.write(0, data);
        return msg(Rwrite, tag, new Writer().u32(written).buf());
      }
      case Tclunk: {
        const fid = r.u32();
        st.fids.delete(fid);
        return msg(Rclunk, tag, new Uint8Array(0));
      }
      case Tremove: {
        const fid = r.u32();
        const f = st.fids.get(fid);
        if (!f) return rerror(tag, "unknown fid");
        if (!f.node.remove) return rerror(tag, "permission denied");
        f.node.remove();
        st.fids.delete(fid);
        return msg(Rremove, tag, new Uint8Array(0));
      }
      case Tstat: {
        const fid = r.u32();
        const f = st.fids.get(fid);
        if (!f) return rerror(tag, "unknown fid");
        return msg(Rstat, tag, statOf(f.node));
      }
      case Twstat:
        return rerror(tag, "wstat not supported");
      default:
        return rerror(tag, "unknown message type");
    }
  }
}

// ---------- client (sequential; one request at a time) ----------

export class NinePClient {
  private sock: any = null;
  private buf = new Uint8Array(0);
  private tag = 1;
  private waiters = new Map<number, (r: Reader) => void>();
  private nextFid = 1;
  private msize = 8192;

  async connect(host: string, port: number): Promise<void> {
    if (this.sock) return;
    this.sock = await Bun.connect({
      hostname: host,
      port,
      socket: {
        data: (_socket: any, data: Uint8Array) => this.onData(data),
        open: () => {},
        close: () => {},
        error: () => {},
      },
    });
    await this.call(Tversion, new Writer().u32(8192).str("9P2000").buf(), NOTAG, (r) => {
      this.msize = r.u32();
      r.str();
    });
  }

  private onData(data: Uint8Array) {
    const next = new Uint8Array(this.buf.length + data.length);
    next.set(this.buf);
    next.set(data, this.buf.length);
    this.buf = next;
    while (this.buf.length >= 4) {
      const size = new DataView(this.buf.buffer, this.buf.byteOffset, 4).getUint32(0, true);
      if (this.buf.length < size) break;
      const frame = this.buf.slice(0, size);
      this.buf = this.buf.slice(size);
      const r = new Reader(frame);
      r.u32();
      const type = r.u8();
      const tag = r.u16();
      const w = this.waiters.get(tag);
      if (!w) continue;
      this.waiters.delete(tag);
      if (type === Rerror) {
        const ename = r.str();
        // Surface as a thrown error via a rejected waiter: encode by
        // throwing inside the waiter through a sentinel.
        (w as any).__error = ename;
        w(r);
      } else {
        w(r);
      }
    }
  }

  private async call(type: number, body: Uint8Array, tag: number, parse: (r: Reader) => void): Promise<void> {
    const useTag = tag === NOTAG ? NOTAG : (this.tag = (this.tag + 1) % 0xfffe || 1);
    const frame = msg(type, useTag, body);
    const p = new Promise<Reader>((resolve, reject) => {
      const waiter = (r: Reader) => {
        const err = (waiter as any).__error;
        if (err) reject(new Error(err));
        else resolve(r);
      };
      this.waiters.set(useTag, waiter);
    });
    await this.sock.write(frame);
    const r = await p;
    parse(r);
  }

  private allocFid(): number { return this.nextFid++; }

  async attach(): Promise<number> {
    const fid = this.allocFid();
    await this.call(Tattach, new Writer().u32(fid).u32(NOFID).str("user").str("").buf(), 0, (r) => { r.qid(); });
    return fid;
  }

  async walk(fid: number, names: string[]): Promise<number> {
    const newfid = this.allocFid();
    await this.call(Twalk, (() => {
      const w = new Writer();
      w.u32(fid).u32(newfid).u16(names.length);
      for (const n of names) w.str(n);
      return w.buf();
    })(), 0, (r) => {
      const n = r.u16();
      for (let i = 0; i < n; i++) r.qid();
    });
    return newfid;
  }

  async open(fid: number, mode = 0): Promise<void> {
    await this.call(Topen, new Writer().u32(fid).u8(mode).buf(), 0, (r) => { r.qid(); r.u32(); });
  }

  async create(fid: number, name: string, isDir: boolean): Promise<void> {
    await this.call(Tcreate, new Writer().u32(fid).str(name).u32(isDir ? DMDIR : 0o644).u8(0).buf(), 0, (r) => { r.qid(); r.u32(); });
  }

  async read(fid: number, offset: number, count: number): Promise<Uint8Array> {
    let out = new Uint8Array(0);
    await this.call(Tread, new Writer().u32(fid).u64(BigInt(offset)).u32(count).buf(), 0, (r) => {
      const n = r.u32();
      out = r.raw(n);
    });
    return out;
  }

  async write(fid: number, data: Uint8Array): Promise<number> {
    let n = 0;
    await this.call(Twrite, new Writer().u32(fid).u64(0n).u32(data.length).raw(data).buf(), 0, (r) => {
      n = r.u32();
    });
    return n;
  }

  async clunk(fid: number): Promise<void> {
    await this.call(Tclunk, new Writer().u32(fid).buf(), 0, () => {});
  }

  async remove(fid: number): Promise<void> {
    await this.call(Tremove, new Writer().u32(fid).buf(), 0, () => {});
  }

  private split(path: string): string[] {
    return path.split("/").filter((s) => s !== "");
  }

  async readFile(path: string): Promise<string> {
    const root = await this.attach();
    try {
      const parts = this.split(path);
      const fid = parts.length ? await this.walk(root, parts) : root;
      try {
        await this.open(fid, 0);
        let off = 0;
        const chunks: Uint8Array[] = [];
        for (;;) {
          const b = await this.read(fid, off, 8192);
          if (b.length === 0) break;
          chunks.push(b);
          off += b.length;
          if (b.length < 8192) break;
        }
        return new TextDecoder().decode(Buffer.concat(chunks));
      } finally {
        await this.clunk(fid);
      }
    } finally {
      if (root !== undefined) await this.clunk(root).catch(() => {});
    }
  }

  async writeFile(path: string, text: string): Promise<void> {
    const parts = this.split(path);
    const name = parts.pop()!;
    const root = await this.attach();
    try {
      const dir = parts.length ? await this.walk(root, parts) : root;
      try {
        const fid = await this.walk(dir, [name]);
        try {
          await this.open(fid, 1);
          await this.write(fid, new TextEncoder().encode(text));
        } finally {
          await this.clunk(fid);
        }
      } finally {
        await this.clunk(dir);
      }
    } finally {
      await this.clunk(root).catch(() => {});
    }
  }

  async listDir(path: string): Promise<{ name: string; isDir: boolean }[]> {
    const root = await this.attach();
    try {
      const parts = this.split(path);
      const fid = parts.length ? await this.walk(root, parts) : root;
      try {
        await this.open(fid, 0);
        const raw = await this.read(fid, 0, 65536);
        const out: { name: string; isDir: boolean }[] = [];
        const r = new Reader(raw);
        while (r.pos < raw.length) {
          const size = r.u16();
          const start = r.pos;
          r.u16(); // type
          r.u32(); // dev
          r.qid();
          const mode = r.u32();
          r.u32(); r.u32(); // atime mtime
          r.u64(); // length
          const name = r.str();
          r.str(); r.str(); r.str();
          r.pos = start + size;
          out.push({ name, isDir: (mode & DMDIR) !== 0 });
        }
        return out;
      } finally {
        await this.clunk(fid);
      }
    } finally {
      await this.clunk(root).catch(() => {});
    }
  }

  async mkdir(path: string): Promise<void> {
    const parts = this.split(path);
    const name = parts.pop()!;
    const root = await this.attach();
    try {
      const dir = parts.length ? await this.walk(root, parts) : root;
      try {
        await this.create(dir, name, true);
      } finally {
        await this.clunk(dir);
      }
    } finally {
      await this.clunk(root).catch(() => {});
    }
  }

  async createFile(path: string): Promise<void> {
    const parts = this.split(path);
    const name = parts.pop()!;
    const root = await this.attach();
    try {
      const dir = parts.length ? await this.walk(root, parts) : root;
      try {
        await this.create(dir, name, false);
      } finally {
        await this.clunk(dir);
      }
    } finally {
      await this.clunk(root).catch(() => {});
    }
  }

  close() {
    try { this.sock?.end(); } catch {}
    this.sock = null;
  }
}

export function parseNinePAddr(addr: string): { host: string; port: number } {
  const i = addr.lastIndexOf(":");
  return { host: addr.slice(0, i) || "127.0.0.1", port: Number(addr.slice(i + 1)) };
}
