# Manual reproduction

This walks through reproducing the Safari 26.4 `createBidirectionalStream()`
hang by hand, in a browser. For automated reproduction see `tests/safari.mjs`.

## Prerequisites

- macOS with Safari 26.4+
- Python 3.9+
- OpenSSL or LibreSSL (macOS default is fine)

## Step 1 — Generate a short-lived self-signed cert

Browsers require certs < 14 days when using `serverCertificateHashes` pinning.

```bash
cd certs
./generate-cert.sh
```

The script prints the cert's SHA-256 hash. Copy it; you'll paste it into the
browser.

## Step 2 — Launch the reproducer server

```bash
cd server
./run.sh
```

This creates a Python venv at `server/.venv`, installs aioquic, applies a
one-line patch so aioquic emits `SETTINGS_WEBTRANSPORT_MAX_SESSIONS = 0xc671706a`
(the pre-draft-13 code point Safari requires for session establishment), then
starts the aioquic demo server on `https://127.0.0.1:4436/` with WebTransport
echo at `/wt`.

Leave it running.

## Step 3 — Open the test page

Open `client/index.html` directly from disk:

```bash
open client/index.html   # macOS
```

Safari will load it as a `file://` URL. That's intentional — it avoids having
to trust a self-signed certificate for the HTTPS page load; WebTransport's
`serverCertificateHashes` handles the cert pin for the WT connection itself.

Paste the SHA-256 hash from step 1 into the **Certificate SHA-256** field.

## Step 4 — Connect

Click **Connect**.

**Expected.** Event log shows:

```
Initial: connecting to https://127.0.0.1:4436/wt (pinned cert hash)...
Initial: connected in 15ms (full handshake)
```

And the status badge turns *Connected*.

## Step 5 — Try a datagram (optional, proves session works)

Type `hello` in the Datagram box and click **Send**.

**Expected.**

```
→ Datagram: "hello"
← Datagram: "hello"
```

Datagrams round-trip fine.

## Step 6 — Try a bidirectional stream (the bug)

Type `hello` in the Bidi Stream box and click **Send**.

**Expected on a working browser (Chrome):**

```
→ Bidi: "hello"
← Bidi: "hello"
```

Returns in a few hundred milliseconds.

**Actual on Safari 26.4:**

```
→ Bidi: "hello"
```

That's it. The response field sits at `waiting...` forever. No error, no
timeout, no close event. The JS promise returned by
`transport.createBidirectionalStream()` never resolves.

## Step 7 — Compare with Chrome

Open `client/index.html` in Chrome. Paste the same hash. Repeat steps 4 → 6.
Bidi echo returns immediately.

---

## What to capture when filing the bug

1. The browser event log text.
2. A `tcpdump -i any -w safari.pcap 'udp port 4436'` while reproducing.
3. Safari → Develop → Show Web Inspector → Network (if any errors surface).

See `evidence/` for captures taken during the investigation that produced this
reproducer.
