"""
Patch aioquic's H3 SETTINGS emission to also advertise
SETTINGS_WEBTRANSPORT_MAX_SESSIONS (codepoint 0xc671706a, pre-draft-13).

Without this, Safari 26.4 rejects the WebTransport session at establishment
with WebTransportError — just like it does against stock webtransport-go and
quic-go. With this one extra setting, Safari connects and datagrams work, and
createBidirectionalStream() hangs — which is the bug this repo reproduces.

Idempotent: re-runs do nothing if the patch is already applied.
"""

from __future__ import annotations

import sys
from pathlib import Path

MARKER_OLD = (
    "        if self._enable_webtransport:\n"
    "            settings[Setting.H3_DATAGRAM] = 1\n"
    "            settings[Setting.ENABLE_WEBTRANSPORT] = 1\n"
    "        return settings"
)
MARKER_NEW = (
    "        if self._enable_webtransport:\n"
    "            settings[Setting.H3_DATAGRAM] = 1\n"
    "            settings[Setting.ENABLE_WEBTRANSPORT] = 1\n"
    "            # Patched for Safari 26.4 bug reproducer:\n"
    "            # SETTINGS_WEBTRANSPORT_MAX_SESSIONS (pre-draft-13, 0xc671706a).\n"
    "            # Safari 26.4 requires this for session establishment.\n"
    "            settings[0xC671706A] = 4\n"
    "        return settings"
)


def find_connection_py() -> Path:
    import aioquic  # noqa: F401 — ensures aioquic is installed

    root = Path(sys.prefix) / "lib"
    for conn in root.glob("python*/site-packages/aioquic/h3/connection.py"):
        return conn
    # Fallback: walk sys.path.
    import aioquic.h3.connection as m

    return Path(m.__file__)


def main() -> int:
    path = find_connection_py()
    text = path.read_text()
    if MARKER_NEW in text:
        print(f"already patched: {path}")
        return 0
    if MARKER_OLD not in text:
        print(
            f"ERROR: expected marker not found in {path}. aioquic version likely differs.\n"
            "Open the file and add WEBTRANSPORT_MAX_SESSIONS = 4 at codepoint 0xc671706a "
            "in _get_local_settings manually.",
            file=sys.stderr,
        )
        return 1
    path.write_text(text.replace(MARKER_OLD, MARKER_NEW))
    print(f"patched: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
