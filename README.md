# Safari 26.4 WebTransport: `createBidirectionalStream()` hangs forever

**Summary.** On Safari 26.4 (the first Safari release to ship WebTransport support,
March 24 2026), `WebTransport.createBidirectionalStream()` returns a promise that
**never resolves** against any non-Apple server. Datagrams on the same session
work correctly, and the same page/script round-trips a bidirectional echo in
Chrome in ~215 ms against the identical server. There is no error, no close,
and no new QUIC stream on the wire.

The failure reproduces on **two independent server codebases** — a pure-Zig
WebTransport stack and patched [aioquic] (Python) — ruling out a server-specific
cause. This repository contains a minimal reproducer.

[aioquic]: https://github.com/aiortc/aioquic

## Environment

| | |
|---|---|
| Safari | 26.4 (21624.1.16.11.4) |
| macOS | Tahoe (Darwin 25.4.0) |
| Reproduced | 2026-04-18 |

## Reproduce in 60 seconds

```bash
# 1. Start the reproducer server (Python, uses patched aioquic).
./server/run.sh           # listens on https://127.0.0.1:4436, serves /wt

# 2. Automated Safari + Chrome side-by-side.
npm install
npm run test:safari       # drives Safari via safaridriver
npm run test:chrome       # drives Chrome via Puppeteer (control)
```

Or [manually](REPRODUCE.md): open `client/index.html` in Safari, click *Connect*,
click *Send Bidi*. The response field stays at `waiting...` forever. Repeat in
Chrome — echo returns in a fraction of a second.

## What you see

| Browser | Session | Datagrams | Bidi stream (client-initiated) |
|---|:-:|:-:|:-:|
| Safari 26.4 | ✓ ~15 ms | ✓ ping/echo | **hangs — promise never resolves** |
| Chrome (latest) | ✓ | ✓ | ✓ ~215 ms echo |

No error, no `transport.closed` rejection, no QUIC STREAM frame on the wire
(server-side `highest_peer_bidi_stream_id` stays 0).

## Key finding

Safari's `createBidirectionalStream()` delegates to Apple's closed-source
Network.framework (`nw_parameters_create_webtransport_http` →
`nw_connection_group_extract_connection` → `nw_connection_start`). The returned
JS promise resolves when the underlying `nw_connection_t` reaches
`nw_connection_state_ready`. In this failure mode that state transition never
happens, even though:

- The WebTransport session is fully established (`transport.ready` resolves).
- Datagrams round-trip correctly on the same session.
- The QUIC connection advertises generous `initial_max_streams_bidi` (100, and
  separately tested with `UINT32_MAX` — no effect).
- No error, no `transport.closed` rejection, no QUIC-level `STOP_SENDING` or
  `RESET_STREAM`.

See [FINDINGS.md](FINDINGS.md) for the full investigation, including a trace
through WebKit source, a log of every H3 SETTINGS combination tested, and the
independent-reproduction evidence on aioquic.

## Repository layout

```
server/                Patched aioquic reproducer
  aioquic_server.py    Minimal WT echo server
  patch.py             Applies the WEBTRANSPORT_MAX_SESSIONS patch to aioquic
  run.sh               Setup venv + install + patch + launch
  requirements.txt
client/
  index.html           Minimal WT bidi + datagram test page
certs/
  generate-cert.sh     One-off self-signed ECDSA P-256 cert generator
tests/
  safari.mjs           selenium-webdriver + safaridriver Safari driver
  chrome.mjs           Puppeteer Chrome control
evidence/
  safari-journal.txt   Server-side QUIC journal while Safari hangs
  safari-browser.txt   Browser event log from the Safari run
  chrome-browser.txt   Browser event log from the Chrome run
  webkit-source-notes.md    Relevant WebKit source quotes and file paths
FINDINGS.md            Full investigation write-up
REPRODUCE.md           Manual reproduction steps (for humans)
```

## Filing

Intended for filing at [bugs.webkit.org](https://bugs.webkit.org/). A ready-to-use
live reproducer is also hosted at **https://echo.web-transport.dev:4440/** — the
cert there is CA-trusted (Let's Encrypt) so no certificate-hash pinning is
required; leave the hash field empty.
