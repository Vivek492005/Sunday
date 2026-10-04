# Privacy Packet-Capture Verification (Release Gate #6)

This document is the human-run procedure for the two remaining Privacy
gate items: **a packet-capture of an idle session** and **network-monitor
verification of local-only mode**. It complements:

- `packages/sundayd/src/privacy-idle.test.ts` — automated, `fetch`-stubbed
  assertion of zero network calls on boot and after `session/list`.
- `scripts/privacy-pcap.mjs` — automated harness that boots a real
  `sundayd` with provider keys scrubbed, runs an idle session plus a
  no-keys chat turn, and polls `ss` for non-loopback sockets owned by the
  daemon. Run it first; it takes ~1 minute:
  `node scripts/privacy-pcap.mjs --duration=60`.

## What "passing" looks like

For an **idle session** (daemon booted, no user task, plus one
`session/list` round-trip): **zero packets** to/from any non-loopback
address attributable to the sundayd process.

For **local-only mode**: with no provider keys configured, a chat turn
fails fast with `missing API key: set OPENROUTER_API_KEY in the
environment` (or the `GROQ_API_KEY` equivalent) and produces **zero**
network traffic. With the gateway pointed at a localhost model server
(Ollama), a chat turn succeeds and **100% of packets are loopback**.

## A. Linux (tcpdump or tshark)

Prerequisites: `tcpdump` (or `tshark`), `ss`, a built sundayd
(`pnpm --filter @sunday/sundayd build`).

1. Start the capture **before** booting the daemon. As root (or with
   `CAP_NET_RAW`), capture everything except loopback:
   ```sh
   sudo tcpdump -i any -w sunday-idle.pcap \
     'tcp and not host 127.0.0.1 and not host ::1'
   ```
   Note the capture start time.
2. In another terminal, scrub provider keys and boot sundayd:
   ```sh
   env -u OPENROUTER_API_KEY -u GROQ_API_KEY \
     node packages/sundayd/dist/cli.js
   ```
   The daemon speaks NDJSON JSON-RPC on stdio; it will sit waiting for
   input (no prompt — that is normal).
3. Send a handshake and an idle RPC. Using a second shell with `jq`
   (or any JSON-RPC client), write to the daemon's stdin:
   ```json
   {"jsonrpc":"2.0","id":1,"method":"sunday/hello","params":{"protocolVersion":1,"client":{"name":"pcap-manual","version":"1.0.0","os":"linux"}}}
   {"jsonrpc":"2.0","id":2,"method":"session/list","params":{}}
   ```
   Confirm both get responses on stdout.
4. Attempt a chat turn (expect the missing-key error, no traffic):
   ```json
   {"jsonrpc":"2.0","id":3,"method":"session/create","params":{"cwd":"/tmp"}}
   {"jsonrpc":"2.0","id":4,"method":"chat/send","params":{"sessionId":"<id-from-3>","message":"hello"}}
   ```
   Expect a `chat/event` notification with `event.type: "turn-error"`
   whose message contains `missing API key`.
5. Leave the daemon idle for **5 minutes**. Do nothing else on the
   machine that would generate noise if you can avoid it.
6. Stop the daemon (`sunday/shutdown` RPC or Ctrl-C), then stop tcpdump
   (Ctrl-C).
7. Analyze:
   ```sh
   tshark -r sunday-idle.pcap -T fields -e frame.time -e ip.src -e ip.dst -e tcp.dstport \
     | sort | uniq -c | sort -rn | head -30
   ```
   **Expected: the capture is empty** (or contains only packets you can
   attribute to other processes — verify with `-e frame.time` against
   your noted start time, and confirm none belong to the sundayd PID;
   correlate with `ss -tnp` snapshots taken during the run).
8. Save `sunday-idle.pcap` plus a notes file (date, machine, sundayd
   version/commit, what you did, verdict) as the gate evidence.

## B. macOS (Wireshark or tcpdump)

1. Install Wireshark (or use the built-in `tcpdump` with `sudo`).
2. Start a capture on the Wi-Fi/Ethernet interface with the display
   filter: `tcp and !(ip.addr == 127.0.0.1) and !(ipv6.addr == ::1)`.
3. Follow steps 2–6 from section A (use `zsh`; the `env -u` form works
   the same).
4. In Wireshark, check **Statistics → Conversations → TCP**: the list
   must contain **no conversation** involving the sundayd process.
   Cross-check PIDs via `lsof -i -P | grep <sundayd-pid>`.
5. Save the `.pcapng` + notes as evidence.

## C. Windows (Wireshark)

1. Install Wireshark with Npcap.
2. Start a capture on the active interface with capture filter:
   `tcp and not host 127.0.0.1 and not host ::1`.
3. Boot sundayd with keys scrubbed (PowerShell):
   ```powershell
   $env:OPENROUTER_API_KEY=$null; $env:GROQ_API_KEY=$null
   node packages/sundayd/dist/cli.js
   ```
   (In `cmd.exe`: `set OPENROUTER_API_KEY=` then `set GROQ_API_KEY=`.)
4. Drive the daemon over stdio as in section A steps 3–4 (any JSON-RPC
   client works; the `sunday` CLI from `packages/sunday-cli` can do
   `sunday status` against the same daemon).
5. Idle 5 minutes, shut down, stop the capture.
6. **Statistics → Conversations → TCP** must show no sundayd
   conversation. Correlate with
   `Get-NetTCPConnection -OwningProcess <pid>` in PowerShell (expect
   nothing, or only loopback).
7. Save `.pcapng` + notes as evidence.

## D. Local-only mode verification

Two configurations, both must be verified:

### D1. No-keys mode (degrades, never phones home)

Covered by section A step 4 and by `scripts/privacy-pcap.mjs`: with
`OPENROUTER_API_KEY` and `GROQ_API_KEY` unset, `chat/send` fails with
`missing API key` **before any socket is opened** (`requireApiKey()`
throws before `fetch`). The pcap must show zero non-loopback packets
for the whole run, including the failed turn.

### D2. Localhost-model mode (fully functional, loopback-only)

1. Run Ollama (or any OpenAI-compatible server) on `127.0.0.1:11434`.
2. Configure the Sunday gateway to use it as the provider endpoint
   (see `docs/PROVIDER_SETUP.md` for the env/config knobs).
3. Start the packet capture from section A/B/C.
4. Run a real chat turn (`chat/send` → expect `turn-end` with
   `finishReason: "stop"` and actual model text).
5. **Expected:** the turn succeeds AND every packet in the capture has
   a loopback address on both ends. Any packet with a non-loopback
   address is a **FAIL** — file it as a privacy bug.
6. Save the pcap + notes as evidence.

## Interpreting results

| Observation | Verdict |
|---|---|
| Empty capture (idle), failed turn with missing-key error, zero non-loopback sockets | **PASS** |
| Packets to non-loopback, attributable to sundayd, during idle | **FAIL** — privacy bug, do not ship |
| Packets to non-loopback only during a user-initiated provider call | Expected — that is the documented BYOK data flow (see `docs/PRIVACY.md`) |
| Packets you can't attribute | Re-run with less machine noise; use PID correlation (`ss -tnp` / `lsof -i` / `Get-NetTCPConnection`) |

## What this does NOT prove

Packet capture observes the **network layer**. It cannot see exfiltration
through a user-configured MCP server or a `run_terminal` command the
agent itself chose to run — those are user-directed data flows,
documented in `docs/PRIVACY.md` ("What leaves the machine, and when").
The in-process guarantee remains the `fetch`-stub idle-silent test plus
code review of the single network surface
(`packages/gateway/src/openai-compatible.ts`).
