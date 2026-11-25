# DeskCloud

Turn any computer into a private, internet-accessible file and media cloud in one command.

## Run It (Zero External Dependencies)

You can run DeskCloud with **either Node.js or Go**—both share the exact same Web UI and CLI flags.

### Option 1: Node.js (18+, zero `npm install`)

```bash
node server.js --tunnel
```

### Option 2: Go (1.22+, or build a single standalone binary)

```bash
# Run directly
go run . --tunnel

# Or compile a single binary with the Web UI embedded (no runtime needed)
go build -o deskcloud .
./deskcloud --tunnel
```

That's it. Open the printed URL, log in with the printed password, and click **Drives & Folders** in the UI to pick what you want to share.

---

## Common Commands

```bash
# Local / LAN only (click "Go Public" in the UI anytime)
node server.js

# Custom password & port
node server.js --tunnel --password "my-secret" --port 9000

# Share specific folders in read-only mode (safe for sharing with friends)
node server.js --tunnel --dir "/path/to/movies" --readonly

# Allow remote Sleep / Restart / Shutdown from the UI (requires password)
node server.js --tunnel --allow-power
```

## Features

- **No setup:** Zero npm dependencies; auto-downloads `cloudflared` when using `--tunnel` or **Go Public**.
- **Built for large libraries:** Fast search, filters, sorting, and pagination for 2,000+ movies & files.
- **Smooth streaming & large uploads:** HTTP Range video seeking + 20 MB chunked uploads.
- **Cross-platform:** Works on Windows, macOS, and Linux.
# desk-cloud
