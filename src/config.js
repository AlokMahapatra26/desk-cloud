'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HELP_TEXT = `
DeskCloud — Turn any computer into a private file & media cloud

Usage:
  node server.js [options]

Options:
  -d, --dir <path>        Directory to share (repeatable for multiple drives/folders)
                          If omitted, loads saved UI folders or starts ready to add in UI
  -p, --port <number>     Port to listen on (default: 8080, or PORT env)
      --host <address>    Host/interface to bind (default: 0.0.0.0, or HOST env)
  -P, --password <pass>   Access password (or STORAGE_PASSWORD env)
                          If omitted, a random password is generated on startup
      --no-auth           Disable password authentication (for trusted LAN only)
  -r, --readonly          Disable uploads, folder creation, renaming, deletion, and root changes
  -t, --tunnel            Automatically expose via Cloudflare Tunnel (downloads cloudflared if needed)
      --allow-power       Allow authenticated remote Shutdown, Restart, and Sleep from the UI
      --roots-file <path> Path to JSON file storing UI-added folders
  -h, --help              Show this help message

Examples:
  node server.js
  node server.js --tunnel
  node server.js --dir "D:\\Movies" --password "my-secret"
  node server.js -d ~/Movies -d ~/Documents -p 9000
`;

function normalizeRootEntries(rawDirs) {
  const roots = [];
  const seenPaths = new Set();

  for (const entry of rawDirs) {
    const rawPath = typeof entry === 'string' ? entry : entry?.path;
    const customName = typeof entry === 'object' && entry?.name ? String(entry.name) : '';
    if (!rawPath) continue;

    const resolved = path.resolve(rawPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Directory does not exist: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolved}`);
    }
    const realPath = fs.realpathSync(resolved);
    if (seenPaths.has(realPath)) continue;
    seenPaths.add(realPath);

    const base = customName || path.basename(realPath) || realPath;
    roots.push({
      id: String(roots.length),
      name: base,
      path: realPath,
    });
  }

  disambiguateRootNames(roots);
  return roots;
}

function disambiguateRootNames(roots) {
  const counts = new Map();
  for (const r of roots) {
    const base = r.baseName || r.name;
    r.baseName = base;
    counts.set(base, (counts.get(base) || 0) + 1);
  }
  for (const r of roots) {
    r.name = counts.get(r.baseName) > 1 ? `${r.baseName} (${r.path})` : r.baseName;
  }
}

function loadSavedRoots(rootsFile) {
  if (!rootsFile || !fs.existsSync(rootsFile)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(rootsFile, 'utf8'));
    if (!Array.isArray(raw)) return [];
    const valid = [];
    for (const item of raw) {
      try {
        if (item && item.path && fs.existsSync(item.path) && fs.statSync(item.path).isDirectory()) {
          valid.push(item);
        }
      } catch {
        // Ignore stale paths
      }
    }
    return normalizeRootEntries(valid);
  } catch {
    return [];
  }
}

/**
 * Parse CLI arguments and environment variables into a normalized config object.
 */
function parseConfig(argv = process.argv.slice(2), env = process.env) {
  const dirs = [];
  let port = env.PORT ? Number(env.PORT) : 8080;
  let host = env.HOST || '0.0.0.0';
  let password = env.STORAGE_PASSWORD || '';
  let noAuth = false;
  let readonly = env.STORAGE_READONLY === '1' || env.STORAGE_READONLY === 'true';
  let tunnel = env.STORAGE_TUNNEL === '1' || env.STORAGE_TUNNEL === 'true';
  let allowPower = env.STORAGE_ALLOW_POWER === '1' || env.STORAGE_ALLOW_POWER === 'true';
  let rootsFile = env.STORAGE_ROOTS_FILE || path.join(os.homedir(), '.storage-server-roots.json');
  let help = false;

  if (env.STORAGE_DIRS) {
    for (const entry of env.STORAGE_DIRS.split(path.delimiter)) {
      if (entry.trim()) dirs.push(entry.trim());
    }
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '-r' || arg === '--readonly') {
      readonly = true;
    } else if (arg === '-t' || arg === '--tunnel') {
      tunnel = true;
    } else if (arg === '--allow-power') {
      allowPower = true;
    } else if (arg === '--no-auth') {
      noAuth = true;
    } else if (arg === '-d' || arg === '--dir') {
      const val = argv[++i];
      if (!val) throw new Error(`Missing value for ${arg}`);
      dirs.push(val);
    } else if (arg.startsWith('--dir=')) {
      dirs.push(arg.slice('--dir='.length));
    } else if (arg === '-p' || arg === '--port') {
      const val = argv[++i];
      if (!val) throw new Error(`Missing value for ${arg}`);
      port = Number(val);
    } else if (arg.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length));
    } else if (arg === '--host') {
      const val = argv[++i];
      if (!val) throw new Error(`Missing value for ${arg}`);
      host = val;
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
    } else if (arg === '-P' || arg === '--password') {
      const val = argv[++i];
      if (!val) throw new Error(`Missing value for ${arg}`);
      password = val;
    } else if (arg.startsWith('--password=')) {
      password = arg.slice('--password='.length);
    } else if (arg === '--roots-file') {
      const val = argv[++i];
      if (!val) throw new Error(`Missing value for ${arg}`);
      rootsFile = path.resolve(val);
    } else if (arg.startsWith('--roots-file=')) {
      rootsFile = path.resolve(arg.slice('--roots-file='.length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }

  const roots = dirs.length > 0
    ? normalizeRootEntries(dirs)
    : loadSavedRoots(rootsFile);

  let generatedPassword = false;
  if (!noAuth && !password) {
    password = crypto.randomBytes(9).toString('base64url');
    generatedPassword = true;
  }

  const sessionSecret = env.STORAGE_SECRET
    ? crypto.createHash('sha256').update(env.STORAGE_SECRET).digest()
    : crypto.randomBytes(32);

  return {
    help,
    port,
    host,
    roots,
    rootsFile,
    cliPinnedRoots: dirs.length > 0,
    authEnabled: !noAuth,
    password,
    generatedPassword,
    readonly,
    tunnel,
    allowPower,
    sessionSecret,
    chunkSizeBytes: 20 * 1024 * 1024,
  };
}

module.exports = { parseConfig, disambiguateRootNames, HELP_TEXT };
