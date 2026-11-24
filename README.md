# DeskCloud

Turn any computer into a private, internet-accessible file and media cloud in one command.

## Run It (Node.js 18+, zero `npm install`)

```bash
node server.js --tunnel
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
```

## Features

- **No setup:** Zero npm dependencies; auto-downloads `cloudflared` when using `--tunnel` or **Go Public**.
- **Built for large libraries:** Fast search, filters, sorting, and pagination for 2,000+ movies & files.
- **Smooth streaming & large uploads:** HTTP Range video seeking + 20 MB chunked uploads.
- **Cross-platform:** Works on Windows, macOS, and Linux.
# desk-cloud
