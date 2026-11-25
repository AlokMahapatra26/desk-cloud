package main

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"deskcloud/internal/deskcloud"
)

//go:embed public/*
var embeddedPublic embed.FS

func getLanAddresses() []string {
	var addrs []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return addrs
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		ifAddrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range ifAddrs {
			if ipnet, ok := a.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
				if v4 := ipnet.IP.To4(); v4 != nil {
					addrs = append(addrs, v4.String())
				}
			}
		}
	}
	return addrs
}

func main() {
	cfg, err := deskcloud.ParseConfig(os.Args[1:], nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		fmt.Fprintln(os.Stderr, "Run with --help for usage.")
		os.Exit(1)
	}
	if cfg.Help {
		fmt.Print(deskcloud.HelpText)
		return
	}

	publicFS, err := fs.Sub(embeddedPublic, "public")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load embedded UI: %v\n", err)
		os.Exit(1)
	}

	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to start server: %v\n", err)
		os.Exit(1)
	}
	boundPort := ln.Addr().(*net.TCPAddr).Port

	tunnelMgr := deskcloud.NewTunnelManager(func() int { return boundPort })
	handler := deskcloud.NewHandler(cfg, deskcloud.ServerOptions{
		PublicFS:      publicFS,
		TunnelManager: tunnelMgr,
	})

	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 60 * time.Second,
	}

	go func() {
		if serveErr := srv.Serve(ln); serveErr != nil && serveErr != http.ErrServerClosed {
			fmt.Fprintf(os.Stderr, "Server error: %v\n", serveErr)
		}
	}()

	fmt.Println("")
	fmt.Println("====================================================")
	fmt.Println("  DeskCloud (Go) is running!")
	fmt.Println("====================================================")
	fmt.Printf("  Local URL : http://localhost:%d\n", boundPort)
	for _, ip := range getLanAddresses() {
		fmt.Printf("  LAN URL   : http://%s:%d\n", ip, boundPort)
	}
	fmt.Println("")
	fmt.Println("  Shared folders:")
	if len(cfg.Roots) == 0 {
		fmt.Println("    (none yet — open the Web UI to add folders or drives)")
	} else {
		for _, r := range cfg.Roots {
			fmt.Printf("    [%s] %s -> %s\n", r.ID, r.Name, r.Path)
		}
	}
	fmt.Println("")
	if cfg.AuthEnabled {
		suffix := ""
		if cfg.GeneratedPassword {
			suffix = " (auto-generated)"
		}
		fmt.Printf("  Password  : %s%s\n", cfg.Password, suffix)
	} else {
		fmt.Println("  Auth      : DISABLED (--no-auth)")
	}
	if cfg.Readonly {
		fmt.Println("  Mode      : READ-ONLY")
	}
	if cfg.AllowPower && !cfg.Readonly && cfg.AuthEnabled {
		fmt.Println("  Power     : ENABLED (--allow-power)")
	}
	fmt.Println("")

	if cfg.Tunnel {
		fmt.Println("  Starting Cloudflare Tunnel...")
		go func() {
			st, err := tunnelMgr.Start()
			if err != nil {
				fmt.Fprintf(os.Stderr, "  Tunnel failed: %v\n", err)
			} else if st.URL != nil {
				fmt.Printf("  Public URL: %s\n", *st.URL)
			}
			fmt.Println("====================================================")
			fmt.Println("")
		}()
	} else {
		fmt.Println("  Expose anywhere with Cloudflare Tunnel:")
		fmt.Println("    deskcloud --tunnel")
		fmt.Println("    (or click \"Go Public\" inside the Web UI)")
		fmt.Println("====================================================")
		fmt.Println("")
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	<-sigCh

	_, _ = tunnelMgr.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

