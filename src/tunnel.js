'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function getDownloadAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'linux') {
    if (arch === 'x64') return { file: 'cloudflared-linux-amd64', archive: false };
    if (arch === 'arm64') return { file: 'cloudflared-linux-arm64', archive: false };
    if (arch === 'arm') return { file: 'cloudflared-linux-arm', archive: false };
  } else if (platform === 'win32') {
    if (arch === 'x64') return { file: 'cloudflared-windows-amd64.exe', archive: false };
    if (arch === 'ia32') return { file: 'cloudflared-windows-386.exe', archive: false };
  } else if (platform === 'darwin') {
    if (arch === 'x64') return { file: 'cloudflared-darwin-amd64.tgz', archive: true };
    if (arch === 'arm64') return { file: 'cloudflared-darwin-arm64.tgz', archive: true };
  }
  throw new Error(`Unsupported platform/arch for auto-download: ${platform}/${arch}`);
}

async function isExecutable(binPath) {
  try {
    await execFileAsync(binPath, ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function ensureCloudflaredBinary({ binDir } = {}) {
  // 1. Use system-installed cloudflared if present in PATH
  if (await isExecutable('cloudflared')) {
    return 'cloudflared';
  }

  // 2. Check cached binary in ~/.storage-server/bin
  const targetDir = binDir || path.join(os.homedir(), '.storage-server', 'bin');
  const exeName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const localBin = path.join(targetDir, exeName);

  if (fs.existsSync(localBin) && (await isExecutable(localBin))) {
    return localBin;
  }

  // 3. Auto-download from official Cloudflare GitHub releases
  const asset = getDownloadAsset();
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset.file}`;

  await fsp.mkdir(targetDir, { recursive: true });
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download cloudflared (${res.status} ${res.statusText})`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  if (asset.archive) {
    // macOS releases are .tgz containing a single `cloudflared` binary
    const tgzPath = path.join(targetDir, asset.file);
    await fsp.writeFile(tgzPath, buffer);
    await execFileAsync('tar', ['-xzf', tgzPath, '-C', targetDir]);
    await fsp.rm(tgzPath, { force: true });
  } else {
    await fsp.writeFile(localBin, buffer);
  }

  if (process.platform !== 'win32') {
    await fsp.chmod(localBin, 0o755);
  }

  return localBin;
}

function createTunnelManager({ getPort, ensureBinary = ensureCloudflaredBinary } = {}) {
  let child = null;
  let state = {
    status: 'stopped', // 'stopped' | 'starting' | 'running' | 'error'
    url: null,
    error: null,
  };
  let startPromise = null;

  function getStatus() {
    return { ...state };
  }

  async function start() {
    if (state.status === 'running') return getStatus();
    if (startPromise) return startPromise;

    startPromise = (async () => {
      state = { status: 'starting', url: null, error: null };
      try {
        const port = typeof getPort === 'function' ? getPort() : 8080;
        const bin = await ensureBinary();

        const url = await new Promise((resolve, reject) => {
          const proc = spawn(
            bin,
            ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
            { stdio: ['ignore', 'pipe', 'pipe'] }
          );
          child = proc;

          let settled = false;
          const timeout = setTimeout(() => {
            if (!settled) {
              settled = true;
              proc.kill();
              reject(new Error('Timed out waiting for Cloudflare Tunnel URL'));
            }
          }, 30000);

          function onOutput(chunk) {
            const text = chunk.toString('utf8');
            const match = TRYCLOUDFLARE_RE.exec(text);
            if (match && !settled) {
              settled = true;
              clearTimeout(timeout);
              resolve(match[0]);
            }
          }

          proc.stdout.on('data', onOutput);
          proc.stderr.on('data', onOutput);

          proc.on('error', (err) => {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              reject(err);
            }
          });

          proc.on('exit', (code) => {
            if (child === proc) child = null;
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              reject(new Error(`cloudflared exited with code ${code}`));
            } else if (state.status === 'running') {
              state = { status: 'stopped', url: null, error: null };
            }
          });
        });

        state = { status: 'running', url, error: null };
        return getStatus();
      } catch (err) {
        state = { status: 'error', url: null, error: err.message || 'Failed to start tunnel' };
        throw err;
      } finally {
        startPromise = null;
      }
    })();

    return startPromise;
  }

  async function stop() {
    if (child) {
      const proc = child;
      child = null;
      proc.kill('SIGTERM');
    }
    state = { status: 'stopped', url: null, error: null };
    return getStatus();
  }

  return { getStatus, start, stop };
}

module.exports = {
  createTunnelManager,
  ensureCloudflaredBinary,
  getDownloadAsset,
};

