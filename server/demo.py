"""
Minimal ASGI app for the aioquic http3_server example — WebTransport echo
endpoint at /wt, plus a trivial landing page.

Adapted from aioquic's examples/demo.py (BSD-licensed, see upstream).
Unchanged behavior; stripped to the parts the reproducer needs.
"""

from __future__ import annotations


async def wt(scope, receive, send):
    """WebTransport echo endpoint: reflects every stream and datagram."""
    message = await receive()
    assert message["type"] == "webtransport.connect"
    await send({"type": "webtransport.accept"})
    while True:
        message = await receive()
        if message["type"] == "webtransport.datagram.receive":
            await send({"data": message["data"], "type": "webtransport.datagram.send"})
        elif message["type"] == "webtransport.stream.receive":
            await send(
                {
                    "data": message["data"],
                    "stream": message["stream"],
                    "type": "webtransport.stream.send",
                }
            )


async def http(scope, receive, send):
    """Trivial HTTP landing so `curl https://127.0.0.1:4436/` reports 200."""
    assert scope["type"] == "http"
    body = b"Safari 26.4 WebTransport reproducer - WT endpoint at /wt\n"
    await send({"type": "http.response.start", "status": 200, "headers": [
        (b"content-type", b"text/plain; charset=utf-8"),
        (b"content-length", str(len(body)).encode()),
    ]})
    await send({"type": "http.response.body", "body": body, "more_body": False})


async def app(scope, receive, send):
    if scope["type"] == "webtransport" and scope["path"] == "/wt":
        await wt(scope, receive, send)
    elif scope["type"] == "http":
        await http(scope, receive, send)
