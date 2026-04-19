#!/usr/bin/env bash
# Build and launch the Go-based (quic-go + webtransport-go) reproducer.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"

CERT="$ROOT/certs/server.crt"
KEY="$ROOT/certs/server.key"
if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "==> no certs yet; running $ROOT/certs/generate-cert.sh"
  "$ROOT/certs/generate-cert.sh"
fi

cd "$DIR"
if [ ! -x ./wt-server ] || [ main.go -nt ./wt-server ]; then
  echo "==> go build"
  go build -o wt-server .
fi

HASH=$(openssl x509 -in "$CERT" -outform der 2>/dev/null | shasum -a 256 | cut -d' ' -f1)
echo
echo "==> certificate SHA-256 (paste into client/index.html):"
echo "    $HASH"
echo

exec ./wt-server -addr 0.0.0.0:4437 -cert "$CERT" -key "$KEY"
