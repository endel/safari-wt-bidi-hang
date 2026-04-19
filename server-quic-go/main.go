// Third independent reproducer: quic-go + webtransport-go (Go stack).
//
// webtransport-go's ConfigureHTTP3Server only adds the single H3 SETTING
// ENABLE_WEBTRANSPORT (0x2b603742). That's not enough for Safari 26.4 —
// Safari rejects at session establishment. We add SETTINGS_WEBTRANSPORT_MAX_SESSIONS
// (pre-draft-13 codepoint 0xc671706a) via the public AdditionalSettings map;
// with that, Safari accepts the session and the bidi-create hang reproduces
// identically to the aioquic and Zig servers.
//
// Listens on :4437 so it doesn't clash with the aioquic reproducer on :4436.
// Uses the same certs/server.{crt,key} as the rest of the repo.
//
// Build and run (needs the Go toolchain):
//   go run . [-addr 0.0.0.0:4437] [-cert ../certs/server.crt] [-key ../certs/server.key]

package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"

	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

// Pre-draft-13 codepoint. Safari 26.4 requires this SETTING > 0 to establish
// a WebTransport session. webtransport-go's ConfigureHTTP3Server omits it.
const settingsWebtransportMaxSessions = 0xc671706a

func main() {
	addr := flag.String("addr", "0.0.0.0:4437", "address to listen on")
	certFile := flag.String("cert", "../certs/server.crt", "TLS certificate file")
	keyFile := flag.String("key", "../certs/server.key", "TLS private key file")
	flag.Parse()

	log.SetFlags(log.Ltime | log.Lmicroseconds)
	log.SetOutput(os.Stdout)

	tlsCert, err := tls.LoadX509KeyPair(*certFile, *keyFile)
	if err != nil {
		log.Fatalf("load cert: %v", err)
	}
	if len(tlsCert.Certificate) == 0 {
		log.Fatalf("cert chain empty")
	}
	certHash := sha256.Sum256(tlsCert.Certificate[0])
	fmt.Printf("\n=== Safari bidi-hang reproducer: quic-go + webtransport-go ===\n")
	fmt.Printf("Certificate SHA-256: %s\n", hex.EncodeToString(certHash[:]))
	fmt.Printf("Listening: https://%s/wt\n\n", *addr)

	h3Server := &http3.Server{
		Addr: *addr,
		TLSConfig: &tls.Config{
			Certificates: []tls.Certificate{tlsCert},
			NextProtos:   []string{http3.NextProtoH3},
		},
	}

	// Apply webtransport-go's usual config, then layer the missing setting.
	webtransport.ConfigureHTTP3Server(h3Server)
	if h3Server.AdditionalSettings == nil {
		h3Server.AdditionalSettings = map[uint64]uint64{}
	}
	h3Server.AdditionalSettings[settingsWebtransportMaxSessions] = 4

	wt := webtransport.Server{
		H3:          h3Server,
		CheckOrigin: func(*http.Request) bool { return true },
	}

	http.HandleFunc("/wt", func(w http.ResponseWriter, r *http.Request) {
		log.Printf("WT CONNECT from %s", r.RemoteAddr)
		sess, err := wt.Upgrade(w, r)
		if err != nil {
			log.Printf("upgrade: %v", err)
			w.WriteHeader(500)
			return
		}
		go handleSession(sess)
	})

	if err := wt.ListenAndServeTLS(*certFile, *keyFile); err != nil {
		log.Fatalf("server: %v", err)
	}
}

func handleSession(sess *webtransport.Session) {
	ctx := context.Background()
	// Accept bidi streams and echo raw bytes.
	go func() {
		for {
			stream, err := sess.AcceptStream(ctx)
			if err != nil {
				return
			}
			go func(s *webtransport.Stream) {
				data, _ := io.ReadAll(s)
				s.Write(data)
				s.Close()
			}(stream)
		}
	}()
	// Accept + echo datagrams.
	go func() {
		for {
			data, err := sess.ReceiveDatagram(ctx)
			if err != nil {
				return
			}
			_ = sess.SendDatagram(data)
		}
	}()
	<-ctx.Done()
}
