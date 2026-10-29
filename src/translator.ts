// translator.ts — comms threads -> cadence run drafts, over 9P only.
//
// The translator never touches an app's database or HTTP API. It reads
// the relay and outpost 9P trees, and writes draft directories into the
// cadence 9P tree's /staging. A human approves (or rejects) each draft
// there; nothing becomes a run on its own.
//
// Run: bun src/translator.ts
//   RELAY_NINEP (default 127.0.0.1:9006), OUTPOST_NINEP (127.0.0.1:9029),
//   CADENCE_NINEP (default 127.0.0.1:9040)
//   TRANSLATOR_DATA (default <repo>/data) — state.json lives here.
//   TRANSLATOR_POLL_MS (default 30000), TRANSLATOR_ONCE=1 for one poll.
//
// Draft rules (deterministic, v1):
// - First-seen thread with at least one message. Group threads skipped.
// - Skipped when every contact email on the thread already exists in
//   cadence's contacts (the contact is already in the system). Threads
//   with no known email still draft — the approval shelf filters those.
// - Draft template: the cadence playbook whose name matches /onboard/i,
//   else empty (the approver fills it before writing approve).
// - Seen state is per-thread message counts; a second poll never
//   re-drafts. A draft directory that already exists is also treated
//   as drafted (crash-safe).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NinePClient, parseNinePAddr } from "./ninep.ts";

export interface TranslatorConfig {
  relay: string;
  outpost: string;
  cadence: string;
  dataDir: string;
}

interface State {
  version: 1;
  relay: Record<string, number>;
  outpost: Record<string, number>;
}

export interface PollReport {
  drafted: string[];
  skippedKnown: string[];
  skippedGroup: string[];
  errors: string[];
}

function loadState(dataDir: string): State {
  try {
    const raw = readFileSync(join(dataDir, "state.json"), "utf8");
    const s = JSON.parse(raw);
    if (s.version === 1) return s;
  } catch {}
  return { version: 1, relay: {}, outpost: {} };
}

function saveState(dataDir: string, state: State) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "state.json"), JSON.stringify(state, null, 2));
}

async function openClient(addr: string): Promise<NinePClient> {
  const { host, port } = parseNinePAddr(addr);
  const c = new NinePClient();
  await c.connect(host, port);
  return c;
}

async function readOrNull(c: NinePClient, path: string): Promise<string | null> {
  try {
    return await c.readFile(path);
  } catch {
    return null;
  }
}

async function listOrEmpty(c: NinePClient, path: string): Promise<{ name: string; isDir: boolean }[]> {
  try {
    return await c.listDir(path);
  } catch {
    return [];
  }
}

async function onboardTemplate(cad: NinePClient): Promise<string> {
  for (const t of await listOrEmpty(cad, "/templates")) {
    if (!t.isDir) continue;
    const name = await readOrNull(cad, `/templates/${t.name}/name`);
    if (name && /onboard/i.test(name)) return t.name;
  }
  return "";
}

async function writeDraft(cad: NinePClient, draftId: string, fields: Record<string, string>): Promise<boolean> {
  try {
    await cad.mkdir(`/staging/${draftId}`);
  } catch (e: any) {
    if (!/exists/i.test(e.message)) throw e;
    return false; // already drafted (crash-safe)
  }
  for (const [k, v] of Object.entries(fields)) {
    await cad.writeFile(`/staging/${draftId}/${k}`, v);
  }
  return true;
}

function clip(body: string): string {
  const b = body.replace(/\s+/g, " ").trim();
  return b.length > 500 ? b.slice(0, 500) + "…" : b;
}

export async function pollOnce(cfg: TranslatorConfig): Promise<PollReport> {
  mkdirSync(cfg.dataDir, { recursive: true });
  const state = loadState(cfg.dataDir);
  const report: PollReport = { drafted: [], skippedKnown: [], skippedGroup: [], errors: [] };

  const cad = await openClient(cfg.cadence).catch((e) => {
    report.errors.push(`cadence: ${e.message}`);
    return null;
  });
  if (!cad) return report;
  let template = "";
  try {
    template = await onboardTemplate(cad);

    // ---- relay ----
    const relay = await openClient(cfg.relay).catch((e) => {
      report.errors.push(`relay: ${e.message}`);
      return null;
    });
    if (relay) {
      try {
        for (const t of await listOrEmpty(relay, "/threads")) {
          if (!t.isDir) continue;
          const id = t.name;
          const msgs = await listOrEmpty(relay, `/threads/${id}/messages`);
          const count = msgs.filter((m) => m.isDir).length;
          if (state.relay[id] !== undefined) {
            state.relay[id] = count;
            continue;
          }
          state.relay[id] = count;
          if (count === 0) continue;
          if ((await readOrNull(relay, `/threads/${id}/is_group`))?.trim() === "1") {
            report.skippedGroup.push(`relay:${id}`);
            continue;
          }
          const contact = (await readOrNull(relay, `/threads/${id}/name`))?.trim() || id;
          const memberIds = (await readOrNull(relay, `/threads/${id}/members`))
            ?.split("\n").map((s) => s.trim()).filter(Boolean) || [];
          const emails: string[] = [];
          for (const mid of memberIds) {
            const em = await readOrNull(relay, `/contacts/${mid}/email`);
            if (em?.trim()) emails.push(em.trim());
          }
          let known = false;
          for (const em of emails) {
            if ((await readOrNull(cad, `/contacts/${em}/name`)) !== null) { known = true; break; }
          }
          if (known && emails.length > 0) {
            report.skippedKnown.push(`relay:${id}`);
            continue;
          }
          let excerpt = "";
          for (const m of msgs.filter((x) => x.isDir)) {
            const body = await readOrNull(relay, `/threads/${id}/messages/${m.name}/body`);
            if (body?.trim()) { excerpt = clip(body); break; }
          }
          const ok = await writeDraft(cad, `relay-${id}`, {
            template, thread: `relay:${id}`, contact, excerpt,
            created: new Date().toISOString(),
          });
          if (ok) report.drafted.push(`relay:${id}`);
        }
      } catch (e: any) {
        report.errors.push(`relay poll: ${e.message}`);
      } finally {
        relay.close();
      }
    }

    // ---- outpost (one thread per contact) ----
    const outpost = await openClient(cfg.outpost).catch((e) => {
      report.errors.push(`outpost: ${e.message}`);
      return null;
    });
    if (outpost) {
      try {
        for (const t of await listOrEmpty(outpost, "/threads")) {
          if (!t.isDir) continue;
          const id = t.name;
          const msgs = await listOrEmpty(outpost, `/threads/${id}/messages`);
          const count = msgs.filter((m) => m.isDir).length;
          if (state.outpost[id] !== undefined) {
            state.outpost[id] = count;
            continue;
          }
          state.outpost[id] = count;
          if (count === 0) continue;
          const contactId = (await readOrNull(outpost, `/threads/${id}/contact`))?.trim() || "";
          const contact = (await readOrNull(outpost, `/threads/${id}/contact_name`))?.trim() || id;
          const email = contactId
            ? (await readOrNull(outpost, `/contacts/${contactId}/email`))?.trim() || ""
            : "";
          if (email && (await readOrNull(cad, `/contacts/${email}/name`)) !== null) {
            report.skippedKnown.push(`outpost:${id}`);
            continue;
          }
          let excerpt = "";
          for (const m of msgs.filter((x) => x.isDir)) {
            const body = await readOrNull(outpost, `/threads/${id}/messages/${m.name}/body`);
            if (body?.trim()) { excerpt = clip(body); break; }
          }
          const ok = await writeDraft(cad, `outpost-${id}`, {
            template, thread: `outpost:${id}`, contact, excerpt,
            created: new Date().toISOString(),
          });
          if (ok) report.drafted.push(`outpost:${id}`);
        }
      } catch (e: any) {
        report.errors.push(`outpost poll: ${e.message}`);
      } finally {
        outpost.close();
      }
    }
  } finally {
    cad.close();
  }
  saveState(cfg.dataDir, state);
  return report;
}

if (import.meta.main) {
  const here = dirname(fileURLToPath(import.meta.url));
  const cfg: TranslatorConfig = {
    relay: process.env.RELAY_NINEP || "127.0.0.1:9006",
    outpost: process.env.OUTPOST_NINEP || "127.0.0.1:9029",
    cadence: process.env.CADENCE_NINEP || "127.0.0.1:9040",
    dataDir: process.env.TRANSLATOR_DATA || join(here, "..", "data"),
  };
  const once = process.env.TRANSLATOR_ONCE === "1";
  const pollMs = Number(process.env.TRANSLATOR_POLL_MS || 30000);
  for (;;) {
    try {
      const r = await pollOnce(cfg);
      for (const d of r.drafted) console.log(`draft ${d}`);
      for (const s of r.skippedKnown) console.log(`skip known ${s}`);
      for (const s of r.skippedGroup) console.log(`skip group ${s}`);
      for (const e of r.errors) console.log(`error ${e}`);
    } catch (e: any) {
      console.log(`error poll: ${e.message}`);
    }
    if (once) break;
    await new Promise((res) => setTimeout(res, pollMs));
  }
}
