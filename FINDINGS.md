# Safari 26.4 WebTransport bidi-create hang — findings

Detailed investigation log. For a short bug description see the main
[README.md](README.md); for human reproduction steps see
[REPRODUCE.md](REPRODUCE.md).

## Shape of the bug

Safari 26.4 establishes a WebTransport session successfully and round-trips
QUIC DATAGRAM frames on it, but `WebTransport.createBidirectionalStream()`
returns a promise that **never resolves or rejects**. No error is visible to
the page author; `transport.closed` does not reject either. Server-side, no
new QUIC STREAM frame ever appears on the wire — Safari's QUIC client never
opens a stream at all.

## Where the hang lives

The relevant client flow (Cocoa / macOS):

```
JS: await transport.createBidirectionalStream()
    ↓
WebCore::WebTransport::createBidirectionalStream
    ↓
WebTransportSession::createBidirectionalStream     (IPC to network process)
    ↓
NetworkTransportSession::createBidirectionalStream     (Cocoa)
    ↓
NetworkTransportSession::createStream(Bidirectional)
    ↓   (creates nw_webtransport_options, extracts nw_connection_t from group)
nw_connection_group_extract_connection        (Apple Network.framework — closed)
    ↓
NetworkTransportStream::start
    ↓
nw_connection_start
    ↓
…waits for nw_connection_state_ready to fire… (never does)
```

Sources inspected:

- `Source/WebKit/NetworkProcess/webtransport/cocoa/NetworkTransportSessionCocoa.mm`
- `Source/WebKit/NetworkProcess/webtransport/cocoa/NetworkTransportStreamCocoa.mm`
- `Source/WebCore/Modules/webtransport/WebTransport.cpp`

WebKit's role in stream creation is mostly plumbing; the decision on when a
stream is "ready" lives inside Apple's closed-source Network.framework
(`nw_parameters_create_webtransport_http` is the entry point).

## Things that are proven to NOT cause it

Each of these was tested against Safari 26.4, either locally or against the
live deployment:

- **QUIC stream credit.** Advertising `initial_max_streams_bidi` of 100 or
  `UINT32_MAX` makes no difference. Safari does not send a QUIC `STREAMS_BLOCKED`
  frame and does not open a stream at all.
- **Certificate-hash pinning vs. CA-trusted.** The hang reproduces with
  self-signed + `serverCertificateHashes` pinning AND with a Let's Encrypt CA
  cert, no hash pin. So the cert-path in WebKit is not the culprit.
- **Page origin.** Reproduces with the page served via HTTPS from the same
  origin as the WT URL, and via `file://` with a pinned cert.
- **Server implementation.** Reproduces on quic-zig (a pure-Zig stack) and on
  [aioquic] (Python); see below.
- **Server-side proactive `MAX_STREAMS_BIDI` / `MAX_STREAMS_UNI`.** Sending
  these right after handshake confirmation has no effect — Safari still never
  opens a stream.
- **`createBidirectionalStream({})` with empty options.** Same result as no
  options.
- **Client JS timing.** Awaiting `transport.ready`, inserting microtask ticks,
  or reading stats before/after all behave the same.

[aioquic]: https://github.com/aiortc/aioquic

## Independent reproduction on aioquic

To verify the bug is not quic-zig-specific, we brought up a minimal aioquic
WebTransport server. By default aioquic emits the following H3 SETTINGS (from
`aioquic/h3/connection.py::_get_local_settings`):

- `QPACK_MAX_TABLE_CAPACITY`
- `QPACK_BLOCKED_STREAMS`
- `ENABLE_CONNECT_PROTOCOL = 1`
- `DUMMY = 1`
- `H3_DATAGRAM = 1`
- `ENABLE_WEBTRANSPORT = 1` (codepoint `0x2b603742`)

Against this stock aioquic, Safari 26.4 fails at **session establishment**
with `WebTransportError`. Same behavior as quic-go's webtransport-go
reference.

Patching aioquic's `_get_local_settings` to also emit
`SETTINGS_WEBTRANSPORT_MAX_SESSIONS = 4` at codepoint `0xc671706a`
(pre-draft-13 ID, the one this repo's quic-zig server emits) unblocks Safari's
session establishment. With that **one-line patch**:

- Safari connects in 14 ms ✓
- Datagrams round-trip ✓
- `createBidirectionalStream()` **hangs identically** to the quic-zig case
- Chrome against the same patched server: perfect bidi echo

Conclusion: the bidi-create hang is not a server-implementation idiosyncrasy.
It reproduces the moment Safari's session negotiation succeeds, regardless of
whether the server is written in Python (aioquic) or Zig (quic-zig).

The repository's `server/patch.py` applies this exact patch; `server/run.sh`
sets it up automatically.

## Why only some servers get Safari past session establishment

Safari 26.4 appears to require the server to advertise
`SETTINGS_WEBTRANSPORT_MAX_SESSIONS` at the pre-draft-13 codepoint
`0xc671706a`, with a non-zero value. Servers that don't emit it
(stock aioquic, quic-go webtransport-go v0.10.0) get a fast
`WebTransportError` at `new WebTransport(...)`. Servers that do emit it
(quic-zig in this investigation, and patched aioquic here) get past session
establishment — at which point the bidi-create hang manifests.

Separately, Safari sends `wt-available-protocols: ` (empty header value) in
its CONNECT request — draft-13+ language — yet rejects any draft-13 SETTINGS
IDs we tried to emit back (`WT_INITIAL_MAX_DATA=0x2b61`,
`WT_INITIAL_MAX_STREAMS_BIDI=0x2b65`, `WT_INITIAL_MAX_STREAMS_UNI=0x2b64`,
`WT_MAX_SESSIONS=0x14e9cd29`). Any one of those, added alone, causes Safari
to fail differently — either refusing session establishment or firing
`H3_REQUEST_CANCELLED (0x010c)` on the CONNECT stream.

Our read: Safari 26.4 appears to have shipped a hybrid/transitional
implementation — it advertises draft-13 language on requests but rejects
draft-13 response SETTINGS, and its working code path only runs against servers
emitting pre-draft-13 SETTINGS. The bidi-create hang is within that working
code path.

## Cross-browser comparison (same URLs)

| Target                                     | Safari session | Safari datagrams | Safari client bidi | Chrome |
|--------------------------------------------|:-:|:-:|:-:|:-:|
| quic-zig (this investigation)              | ✓ | ✓ | **HANG** | ✓ |
| Patched aioquic (this repo)                | ✓ | ✓ | **HANG** | ✓ |
| Stock aioquic                              | ✗ (reject) | — | — | ✓ |
| quic-go webtransport-go v0.10.0            | ✗ (reject) | — | — | ✓ |
| akaleapi `wt-ord.akaleapi.net:6161/echo`   | ✗ (no connect) | — | — | ✓ |

Chrome is a clean control — bidi echo round-trips in ~215 ms against every
one of these.

## Open questions for the WebKit team

1. What signal is `nw_connection_state_ready` waiting for when a bidi stream
   is extracted from the session connection group? From the outside it looks
   like it's waiting on something that never happens, with no error.
2. Why does Safari require the pre-draft-13 `SETTINGS_WEBTRANSPORT_MAX_SESSIONS`
   at `0xc671706a` for session establishment, yet send `wt-available-protocols`
   (a draft-13+ header) on the CONNECT request?
3. Is there a fully working reference server (other than Apple's private
   `nw_listener`-based test server in `Tools/TestWebKitAPI/Helpers/cocoa/WebTransportServer.mm`)
   that developers can test against while the ecosystem converges?

## Environment

```
Safari  26.4 (21624.1.16.11.4)
macOS   Tahoe (Darwin 25.4.0)
Date    2026-04-18
```

Reproduced locally and against a deployed server at
`https://echo.web-transport.dev:4440/`. Reproducer code and automation in
this repository.
