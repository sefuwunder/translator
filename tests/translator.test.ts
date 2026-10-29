// translator.test.ts — translator end-to-end against stub 9P trees.
//
// The stubs stand in for the relay, outpost, and cadence trees using
// only this repo's vendored ninep.ts, so `bun test` passes in a fresh
// clone with no sibling checkouts. The translator itself only ever
// speaks 9P, so the stubs exercise its full decision logic: drafting,
// known-contact skip, group skip, template match, idempotent re-poll.
// Integration against the real app trees was verified in the workspace
// on 2026-10-29 (the same assertions, real servers).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { serveNineP, NinePClient, type DirNode, type FileNode, type Node } from "../src/ninep.ts";
import { pollOnce } from "../src/translator.ts";

function textFile(name: string, path: string, value: string): FileNode {
  return {
    kind: "file", name, path,
    len: () => new TextEncoder().encode(value).length,
    read: (off: number, count: number) => new TextEncoder().encode(value).slice(off, off + count),
    mtime: () => Date.now(),
  };
}

function dirNode(name: string, path: string, kids: Record<string, Node>,
  create?: (n: string, isDir: boolean) => Node): DirNode {
  return {
    kind: "dir", name, path,
    list: () => Object.values(kids).map((k) => ({ name: k.name, isDir: k.kind === "dir" })),
    get: (n: string) => kids[n] || null,
    create,
    mtime: () => Date.now(),
  };
}

function msgDir(threadPath: string, msgs: Record<string, string>): DirNode {
  const kids: Record<string, Node> = {};
  for (const [id, body] of Object.entries(msgs)) {
    kids[id] = dirNode(id, `${threadPath}/messages/${id}`, {
      body: textFile("body", `${threadPath}/messages/${id}/body`, body),
    });
  }
  return dirNode("messages", `${threadPath}/messages`, kids);
}

// ---- relay stub ----
function relayTree(): DirNode {
  const contacts: Record<string, Node> = {
    "c-known": dirNode("c-known", "/contacts/c-known", {
      email: textFile("email", "/contacts/c-known/email", "known@acme.example"),
    }),
    "c-new": dirNode("c-new", "/contacts/c-new", {
      email: textFile("email", "/contacts/c-new/email", "new@acme.example"),
    }),
  };
  const thread = (id: string, name: string, isGroup: string, members: string, msgs: Record<string, string>) =>
    dirNode(id, `/threads/${id}`, {
      name: textFile("name", `/threads/${id}/name`, name),
      is_group: textFile("is_group", `/threads/${id}/is_group`, isGroup),
      members: textFile("members", `/threads/${id}/members`, members),
      messages: msgDir(`/threads/${id}`, msgs),
    });
  const threads: Record<string, Node> = {
    "t-known": thread("t-known", "Known Person", "0", "c-known\n", { m1: "hello from known" }),
    "t-new": thread("t-new", "New Person", "0", "c-new\n", { m2: "we want to start" }),
    "t-group": thread("t-group", "Team", "1", "c-known\nc-new\n", { m3: "team note" }),
  };
  return dirNode("", "/", {
    contacts: dirNode("contacts", "/contacts", contacts),
    threads: dirNode("threads", "/threads", threads),
  });
}

// ---- outpost stub ----
function outpostTree(): DirNode {
  const contacts: Record<string, Node> = {
    "oc-1": dirNode("oc-1", "/contacts/oc-1", {
      email: textFile("email", "/contacts/oc-1/email", "fresh@acme.example"),
    }),
  };
  const threads: Record<string, Node> = {
    "o-1": dirNode("o-1", "/threads/o-1", {
      contact: textFile("contact", "/threads/o-1/contact", "oc-1"),
      contact_name: textFile("contact_name", "/threads/o-1/contact_name", "Fresh Person"),
      messages: msgDir("/threads/o-1", { "om-1": "fresh hello" }),
    }),
  };
  return dirNode("", "/", {
    contacts: dirNode("contacts", "/contacts", contacts),
    threads: dirNode("threads", "/threads", threads),
  });
}

// ---- cadence stub: templates + contacts + mutable staging ----
function cadenceTree(): DirNode {
  const staging = new Map<string, Map<string, string>>();
  const draftNode = (id: string): DirNode => {
    const fields = staging.get(id)!;
    return dirNode(id, `/staging/${id}`,
      Object.fromEntries([...fields.entries()].map(([k, v]) => {
        const f = { value: v };
        return [k, {
          kind: "file", name: k, path: `/staging/${id}/${k}`,
          len: () => new TextEncoder().encode(f.value).length,
          read: (off: number, count: number) =>
            new TextEncoder().encode(f.value).slice(off, off + count),
          write: (off: number, data: Uint8Array) => {
            if (off !== 0) throw new Error("offset must be 0");
            f.value = new TextDecoder().decode(data);
            fields.set(k, f.value);
            return data.length;
          },
          mtime: () => Date.now(),
        } as FileNode];
      })),
      (n: string, isDir: boolean) => {
        if (isDir) throw new Error("no subdirectories in a draft");
        fields.set(n, "");
        return draftNode(id).get(n)!;
      });
  };
  const stagingNode = dirNode("staging", "/staging", {},
    (n: string, isDir: boolean) => {
      if (!isDir) throw new Error("drafts are directories");
      const fields = new Map<string, string>([
        ["template", ""], ["thread", ""], ["contact", ""], ["excerpt", ""],
        ["created", new Date().toISOString()], ["status", "proposed"], ["result", ""],
      ]);
      staging.set(n, fields);
      return draftNode(n);
    });
  // list()/get() must see live drafts, so override with closures over the map.
  (stagingNode as any).list = () =>
    [...staging.keys()].map((n) => ({ name: n, isDir: true }));
  (stagingNode as any).get = (n: string) => (staging.has(n) ? draftNode(n) : null);
  return dirNode("", "/", {
    templates: dirNode("templates", "/templates", {
      "pb-onb": dirNode("pb-onb", "/templates/pb-onb", {
        name: textFile("name", "/templates/pb-onb/name", "Client Onboarding"),
      }),
    }),
    contacts: dirNode("contacts", "/contacts", {
      "known@acme.example": dirNode("known@acme.example", "/contacts/known@acme.example", {
        name: textFile("name", "/contacts/known@acme.example/name", "Known Person"),
      }),
    }),
    staging: stagingNode,
  });
}

let tmp = "";
let relayPort = 0, outpostPort = 0, cadencePort = 0;
let servers: any[] = [];

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "translator-9p-"));
  const relay = serveNineP(relayTree(), { port: 0 });
  const outpost = serveNineP(outpostTree(), { port: 0 });
  const cadence = serveNineP(cadenceTree(), { port: 0 });
  servers = [relay, outpost, cadence];
  relayPort = relay.port;
  outpostPort = outpost.port;
  cadencePort = cadence.port;
});

afterAll(() => {
  for (const s of servers) s.stop();
  rmSync(tmp, { recursive: true, force: true });
});

async function cadenceClient() {
  const c = new NinePClient();
  await c.connect("127.0.0.1", cadencePort);
  return c;
}

function cfg() {
  return {
    relay: `127.0.0.1:${relayPort}`,
    outpost: `127.0.0.1:${outpostPort}`,
    cadence: `127.0.0.1:${cadencePort}`,
    dataDir: join(tmp, "tdata"),
  };
}

describe("translator end-to-end", () => {
  test("first poll drafts new threads, skips known and group threads", async () => {
    const report = await pollOnce(cfg());
    expect(report.errors).toEqual([]);
    expect(report.drafted.sort()).toEqual(["outpost:o-1", "relay:t-new"]);
    expect(report.skippedKnown).toEqual(["relay:t-known"]);
    expect(report.skippedGroup).toEqual(["relay:t-group"]);

    const c = await cadenceClient();
    try {
      const names = (await c.listDir("/staging")).map((e) => e.name).sort();
      expect(names).toEqual(["outpost-o-1", "relay-t-new"]);
      expect(await c.readFile("/staging/relay-t-new/thread")).toBe("relay:t-new");
      expect(await c.readFile("/staging/relay-t-new/contact")).toBe("New Person");
      expect(await c.readFile("/staging/relay-t-new/template")).toBe("pb-onb");
      expect(await c.readFile("/staging/relay-t-new/excerpt")).toContain("we want to start");
      expect(await c.readFile("/staging/relay-t-new/status")).toBe("proposed");
      expect(await c.readFile("/staging/outpost-o-1/thread")).toBe("outpost:o-1");
      expect(await c.readFile("/staging/outpost-o-1/contact")).toBe("Fresh Person");
    } finally {
      c.close();
    }
  });

  test("second poll drafts nothing new", async () => {
    const report = await pollOnce(cfg());
    expect(report.drafted).toEqual([]);
    const c = await cadenceClient();
    try {
      const names = (await c.listDir("/staging")).map((e) => e.name).sort();
      expect(names).toEqual(["outpost-o-1", "relay-t-new"]);
    } finally {
      c.close();
    }
  });
});
