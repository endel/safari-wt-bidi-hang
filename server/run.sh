#!/usr/bin/env bash
# One-command setup + launch for the Safari 26.4 WebTransport bidi-hang
# reproducer. Creates a Python venv, installs aioquic, applies the
# WEBTRANSPORT_MAX_SESSIONS patch (so Safari gets past session negotiation),
# and starts the demo echo server on https://127.0.0.1:4436/wt.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
VENV="$DIR/.venv"
PYTHON=${PYTHON:-python3}

if [ ! -d "$VENV" ]; then
  echo "==> creating venv at $VENV"
  "$PYTHON" -m venv "$VENV"
fi

echo "==> installing aioquic + deps"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q aioquic starlette wsproto

echo "==> applying WEBTRANSPORT_MAX_SESSIONS patch to aioquic"
"$VENV/bin/python" "$DIR/patch.py"

# Fetch aioquic's upstream http3_server example (the ASGI driver). Don't
# vendor it here — it's upstream code and we should respect its licensing.
AIOQUIC_VERSION=$("$VENV/bin/pip" show aioquic | awk '/^Version:/ {print $2}')
H3SERVER="$DIR/http3_server.py"
if [ ! -f "$H3SERVER" ]; then
  echo "==> fetching aioquic $AIOQUIC_VERSION http3_server.py example"
  curl -fsSL "https://raw.githubusercontent.com/aiortc/aioquic/${AIOQUIC_VERSION}/examples/http3_server.py" \
    -o "$H3SERVER" \
    || curl -fsSL "https://raw.githubusercontent.com/aiortc/aioquic/main/examples/http3_server.py" \
         -o "$H3SERVER"
fi

CERT="$ROOT/certs/server.crt"
KEY="$ROOT/certs/server.key"
if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "==> no certs yet; running $ROOT/certs/generate-cert.sh"
  "$ROOT/certs/generate-cert.sh"
fi

# Print the cert hash so a human reproducer can paste it into client/index.html.
HASH=$(openssl x509 -in "$CERT" -outform der 2>/dev/null | shasum -a 256 | cut -d' ' -f1)
echo
echo "==> certificate SHA-256 (paste this into client/index.html):"
echo "    $HASH"
echo

# The aioquic http3_server example expects STATIC_ROOT; give it an empty dir.
STATIC="$DIR/.static"
mkdir -p "$STATIC"

echo "==> launching aioquic WT echo server on https://127.0.0.1:4436/wt"
echo "    (Ctrl-C to stop)"
echo
STATIC_ROOT="$STATIC" exec "$VENV/bin/python" "$DIR/http3_server.py" \
  --certificate "$CERT" \
  --private-key "$KEY" \
  --host 0.0.0.0 \
  --port 4436 \
  -v \
  demo:app
