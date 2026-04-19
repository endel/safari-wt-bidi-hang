# WebKit source references

Where `createBidirectionalStream()` goes and where it gets stuck.

All paths relative to https://github.com/WebKit/WebKit main branch as of
2026-04-18.

## Client-side call chain

```
JS:      transport.createBidirectionalStream()
           ↓
WebCore: WebTransport::createBidirectionalStream                                 [1]
           ↓  (session->createBidirectionalStream() — IPC to network process)
WebKit:  NetworkTransportSession::createBidirectionalStream                      [2]
           ↓
         NetworkTransportSession::createStream(NetworkTransportStreamType::Bidirectional)
           ↓  (Cocoa)
         nw_webtransport_create_options()
           ↓  set_is_unidirectional(false), set_is_datagram(false),
              set_allow_joining_before_ready(true)
         nw_connection_group_extract_connection(m_connectionGroup, nil, options) [3]
           ↓
         NetworkTransportStream::create(...)->start(readyHandler)                [4]
           ↓
         nw_connection_set_state_changed_handler(...)
         nw_connection_start(m_connection)
           ↓
         …waits for nw_connection_state_ready… (never fires in this bug)
```

[1] Source/WebCore/Modules/webtransport/WebTransport.cpp:549

    ```cpp
    void WebTransport::createBidirectionalStream(ScriptExecutionContext& context, WebTransportSendStreamOptions&&, Ref<DeferredPromise>&& promise)
    {
        RefPtr session = m_session;
        if (m_state == State::Closed || m_state == State::Failed || !session)
            return promise->reject(ExceptionCode::InvalidStateError);

        context.enqueueTaskWhenSettled(session->createBidirectionalStream(), WebCore::TaskSource::Networking, [/*...*/] (auto&& identifier) mutable {
            if (!identifier)
                return promise->reject(ExceptionCode::InvalidStateError);
            /* resolve with stream */
        });
    }
    ```

[2] Source/WebKit/NetworkProcess/webtransport/cocoa/NetworkTransportSessionCocoa.mm:510

    ```objc
    void NetworkTransportSession::createStream(NetworkTransportStreamType streamType, CompletionHandler<void(std::optional<WebCore::WebTransportStreamIdentifier>)>&& completionHandler)
    {
        /* ... */
        softLink_Network_nw_webtransport_options_set_is_unidirectional(webtransportOptions.get(), streamType != NetworkTransportStreamType::Bidirectional);
        softLink_Network_nw_webtransport_options_set_is_datagram(webtransportOptions.get(), false);
        if (canLoad_Network_nw_webtransport_options_set_allow_joining_before_ready())
            softLink_Network_nw_webtransport_options_set_allow_joining_before_ready(webtransportOptions.get(), true);
        RetainPtr connection = adoptNS(nw_connection_group_extract_connection(m_connectionGroup.get(), nil, webtransportOptions.get()));
        /* ... */
        stream->start([/*...*/] (std::optional<NetworkTransportStreamType> streamType) mutable {
            /* resolve/reject based on stream readiness */
        });
    }
    ```

[3] `nw_connection_group_extract_connection` is an Apple SPI and its
    implementation lives in the closed-source `libnetwork.dylib` /
    `Network.framework`. WebKit only calls it; it cannot inspect or debug
    what gates the readiness state transition.

[4] Source/WebKit/NetworkProcess/webtransport/cocoa/NetworkTransportStreamCocoa.mm:53

    ```objc
    void NetworkTransportStream::start(NetworkTransportStreamReadyHandler&& readyHandler)
    {
        nw_connection_set_state_changed_handler(m_connection.get(), makeBlockPtr([/*...*/] (nw_connection_state_t state, nw_error_t error) mutable {
            switch (state) {
            case nw_connection_state_invalid:
            case nw_connection_state_waiting:
            case nw_connection_state_preparing:
            case nw_connection_state_cancelled:
                return;  // keep waiting — another state change will come
            case nw_connection_state_ready:
                /* fires readyHandler with the stream type → promise resolves */
            case nw_connection_state_failed:
                /* fires readyHandler with std::nullopt → promise rejects */
            }
        }).get());
        nw_connection_set_queue(m_connection.get(), mainDispatchQueueSingleton());
        nw_connection_start(m_connection.get());
    }
    ```

In the bug scenario the state-changed handler appears to hover on
`nw_connection_state_invalid`/`waiting`/`preparing` indefinitely. Neither
`ready` nor `failed` is observed from outside.

## Session options emitted on CONNECT

For reference, this is what WebKit asks Network.framework to set on the
outgoing WT session (`NetworkTransportSessionCocoa.mm:200-216`):

```objc
auto configureWebTransport = [/*...*/](nw_protocol_options_t options) {
    softLink_Network_nw_webtransport_options_set_is_unidirectional(options, false);
    softLink_Network_nw_webtransport_options_set_is_datagram(options, true);
    softLink_Network_nw_webtransport_options_add_connect_request_header(options, "origin", clientOrigin.utf8().data());
    if (canLoad_Network_nw_webtransport_options_set_allow_joining_before_ready())
        softLink_Network_nw_webtransport_options_set_allow_joining_before_ready(options, true);
    if (canLoad_Network_nw_webtransport_options_set_initial_max_streams_uni())
        softLink_Network_nw_webtransport_options_set_initial_max_streams_uni(options, maxStreamsUni);
    if (canLoad_Network_nw_webtransport_options_set_initial_max_streams_bidi())
        softLink_Network_nw_webtransport_options_set_initial_max_streams_bidi(options, maxStreamsBidi);
    softLink_Network_nw_webtransport_options_add_connect_request_header(options, "wt-available-protocols", protocols.utf8().data());
};
```

Observed wire behavior: Safari 26.4's CONNECT request carries
`wt-available-protocols: ` (empty value) — draft-13+ language — suggesting
Network.framework's WT stack is in a draft-13+ mode. Yet when the server
advertises draft-13+ SETTINGS (`WT_INITIAL_MAX_STREAMS_BIDI=0x2b65`,
`WT_INITIAL_MAX_DATA=0x2b61`, `WT_MAX_SESSIONS=0x14e9cd29`), the session
fails to establish — Safari either fast-rejects with `H3_REQUEST_CANCELLED
(0x010c)` on the CONNECT stream or silently fails to connect.

The bug reproduces only in the narrow overlap where the server emits
pre-draft-13 `SETTINGS_WEBTRANSPORT_MAX_SESSIONS (0xc671706a)` so session
negotiation passes, and no draft-13 per-session credit SETTINGS so Safari
doesn't bail. That's the configuration both servers in this repository use.
