# Translator

Comms threads become cadence run drafts, over 9P only. The
translator never touches an app's database or HTTP API: it reads
the relay and outpost 9P trees and writes draft directories into
the cadence 9P tree's `/staging`. A human approves or rejects each
draft there; nothing becomes a run on its own.

## Run

```
bun src/translator.ts
```

Environment: `RELAY_NINEP` (default `127.0.0.1:9006`),
`OUTPOST_NINEP` (default `127.0.0.1:9029`), `CADENCE_NINEP`
(default `127.0.0.1:9040`), `TRANSLATOR_DATA` (default
`<repo>/data`, where `state.json` lives),
`TRANSLATOR_POLL_MS` (default 30000), `TRANSLATOR_ONCE=1` for a
single poll and exit.

Start the three 9P servers first (each app's `Doc/ninep.md` has
its command), then start the translator.

## Draft rules (deterministic, v1)

- First-seen thread with at least one message. Group threads skipped.
- Skipped when every contact email on the thread already exists in
  cadence's contacts — the contact is already in the system.
  Threads with no known email still draft; the approval shelf
  filters those.
- Draft template: the cadence playbook whose name matches
  `/onboard/i`, else empty (the approver fills it before writing
  `approve`).
- Seen state is per-thread message counts in `state.json`; a
  second poll never re-drafts. A draft directory that already
  exists is also treated as drafted, so a crash mid-poll is safe.

## Draft contents

```
staging/<source>-<thread>/{template, thread, contact, excerpt, created, status, result}
```

`thread` is `relay:<id>` or `outpost:<id>`; `excerpt` is the first
message body, clipped to 500 characters. Approval, rejection, and
the run creation itself happen in cadence's tree — see
cadence's `Doc/ninep.md`.

## Tests

```
bun test
```

The suite is self-contained: stub 9P trees stand in for the relay,
outpost, and cadence servers, so it passes in a fresh clone with no
sibling checkouts. Integration against the real app trees was
verified in the workspace on 2026-10-29.
