'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { parseConfig } = require('../src/config');
const { startServer } = require('../server');
const { getDownloadAsset } = require('../src/tunnel');
const { getPowerCommand } = require('../src/power');

async function createTestEnv({ readonly = false, allowPower = false, extraDirs = [], omitDir = false, tunnelManager, powerRunner } = {}) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'storage-srv-test-'));
  const rootsFile = path.join(tmpDir, 'roots.json');
  const args = ['--port', '0', '--host', '127.0.0.1', '--password', 'test-pass', '--roots-file', rootsFile];
  if (!omitDir) args.push('--dir', tmpDir);
  if (readonly) args.push('--readonly');
  if (allowPower) args.push('--allow-power');
  for (const d of extraDirs) args.push('--dir', d);

  const config = parseConfig(args, {});
  const server = await startServer(config, { tunnelManager, powerRunner });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    tmpDir,
    rootsFile,
    baseUrl,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await fsp.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

async function login(baseUrl, password = 'test-pass') {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const setCookie = res.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  return { res, cookie };
}

test('authentication, rate/password validation, and logout', async () => {
  const env = await createTestEnv();
  try {
    const unauth = await fetch(`${env.baseUrl}/api/list`);
    assert.equal(unauth.status, 401);

    const bad = await login(env.baseUrl, 'wrong');
    assert.equal(bad.res.status, 401);

    const good = await login(env.baseUrl, 'test-pass');
    assert.equal(good.res.status, 200);
    assert.ok(good.cookie.startsWith('storage_session='));

    const authed = await fetch(`${env.baseUrl}/api/list`, {
      headers: { Cookie: good.cookie },
    });
    assert.equal(authed.status, 200);

    const logoutRes = await fetch(`${env.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: good.cookie },
    });
    assert.equal(logoutRes.status, 200);
  } finally {
    await env.close();
  }
});

test('lists 2200+ files with pagination, search, and video filter', async () => {
  const env = await createTestEnv();
  try {
    // Create 2,200 dummy movie files + 5 text files
    const creates = [];
    for (let i = 0; i < 2200; i++) {
      const name = `Movie_${String(i).padStart(4, '0')}.mp4`;
      creates.push(fsp.writeFile(path.join(env.tmpDir, name), ''));
    }
    for (let i = 0; i < 5; i++) {
      creates.push(fsp.writeFile(path.join(env.tmpDir, `notes_${i}.txt`), 'hi'));
    }
    await Promise.all(creates);

    const { cookie } = await login(env.baseUrl);

    const page1Res = await fetch(`${env.baseUrl}/api/list?type=video&page=1&limit=100`, {
      headers: { Cookie: cookie },
    });
    assert.equal(page1Res.status, 200);
    const page1 = await page1Res.json();
    assert.equal(page1.total, 2200);
    assert.equal(page1.totalPages, 22);
    assert.equal(page1.items.length, 100);
    assert.equal(page1.items[0].name, 'Movie_0000.mp4');

    const searchRes = await fetch(`${env.baseUrl}/api/list?search=Movie_1999`, {
      headers: { Cookie: cookie },
    });
    const searchData = await searchRes.json();
    assert.equal(searchData.total, 1);
    assert.equal(searchData.items[0].name, 'Movie_1999.mp4');
  } finally {
    await env.close();
  }
});

test('HTTP Range streaming (206 Partial Content) and 416 handling', async () => {
  const env = await createTestEnv();
  try {
    const payload = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    await fsp.writeFile(path.join(env.tmpDir, 'sample.mp4'), payload);
    const { cookie } = await login(env.baseUrl);

    const rangeRes = await fetch(`${env.baseUrl}/api/stream?root=0&path=sample.mp4`, {
      headers: { Cookie: cookie, Range: 'bytes=10-19' },
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get('content-range'), `bytes 10-19/${payload.length}`);
    assert.equal(await rangeRes.text(), 'ABCDEFGHIJ');

    const badRange = await fetch(`${env.baseUrl}/api/stream?root=0&path=sample.mp4`, {
      headers: { Cookie: cookie, Range: 'bytes=999-1000' },
    });
    assert.equal(badRange.status, 416);
  } finally {
    await env.close();
  }
});

test('path traversal is blocked', async () => {
  const env = await createTestEnv();
  try {
    const { cookie } = await login(env.baseUrl);
    const res = await fetch(`${env.baseUrl}/api/list?path=../../etc`, {
      headers: { Cookie: cookie },
    });
    assert.ok(res.status === 400 || res.status === 403);
  } finally {
    await env.close();
  }
});

test('chunked upload, mkdir, rename, delete, and readonly mode', async () => {
  const env = await createTestEnv();
  try {
    const { cookie } = await login(env.baseUrl);

    // Create folder
    const mkRes = await fetch(`${env.baseUrl}/api/mkdir`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: '0', path: '', name: 'Action' }),
    });
    assert.equal(mkRes.status, 200);

    // Chunked upload into Action/test.bin
    const part1 = Buffer.from('Hello ');
    const part2 = Buffer.from('Cloudflare!');
    const initRes = await fetch(`${env.baseUrl}/api/upload/init`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        root: '0',
        path: 'Action',
        filename: 'test.bin',
        totalChunks: 2,
        totalSize: part1.length + part2.length,
      }),
    });
    const { uploadId } = await initRes.json();
    assert.ok(uploadId);

    for (const [idx, buf] of [part1, part2].entries()) {
      const cRes = await fetch(
        `${env.baseUrl}/api/upload/chunk?uploadId=${uploadId}&index=${idx}`,
        {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
          body: buf,
        }
      );
      assert.equal(cRes.status, 200);
    }

    const doneRes = await fetch(`${env.baseUrl}/api/upload/complete`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    });
    assert.equal(doneRes.status, 200);

    const written = await fsp.readFile(path.join(env.tmpDir, 'Action', 'test.bin'), 'utf8');
    assert.equal(written, 'Hello Cloudflare!');

    // Rename & Delete
    const renRes = await fetch(`${env.baseUrl}/api/rename`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: '0', path: 'Action/test.bin', newName: 'renamed.bin' }),
    });
    assert.equal(renRes.status, 200);

    const delRes = await fetch(`${env.baseUrl}/api/delete`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: '0', path: 'Action/renamed.bin' }),
    });
    assert.equal(delRes.status, 200);
  } finally {
    await env.close();
  }

  // Verify --readonly blocks mutations
  const roEnv = await createTestEnv({ readonly: true });
  try {
    const { cookie } = await login(roEnv.baseUrl);
    const roMk = await fetch(`${roEnv.baseUrl}/api/mkdir`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: '0', path: '', name: 'Nope' }),
    });
    assert.equal(roMk.status, 403);

    const roBrowse = await fetch(`${roEnv.baseUrl}/api/system/browse`, {
      headers: { Cookie: cookie },
    });
    assert.equal(roBrowse.status, 403);

    const roAddRoot = await fetch(`${roEnv.baseUrl}/api/roots/add`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: roEnv.tmpDir }),
    });
    assert.equal(roAddRoot.status, 403);
  } finally {
    await roEnv.close();
  }
});

test('UI root management: browse system dirs, add root, persist, and remove root', async () => {
  const env = await createTestEnv({ omitDir: true });
  try {
    const moviesDir = path.join(env.tmpDir, 'MyMovies');
    await fsp.mkdir(moviesDir);
    await fsp.writeFile(path.join(moviesDir, 'film.mp4'), 'video');

    const { cookie } = await login(env.baseUrl);

    // Initially empty when started without --dir
    const initialList = await (await fetch(`${env.baseUrl}/api/list`, {
      headers: { Cookie: cookie },
    })).json();
    assert.equal(initialList.roots.length, 0);

    // Browse host quick locations and then env.tmpDir
    const sysQuick = await (await fetch(`${env.baseUrl}/api/system/browse`, {
      headers: { Cookie: cookie },
    })).json();
    assert.ok(Array.isArray(sysQuick.directories));
    assert.ok(sysQuick.directories.length > 0);

    const sysSub = await (await fetch(
      `${env.baseUrl}/api/system/browse?path=${encodeURIComponent(env.tmpDir)}`,
      { headers: { Cookie: cookie } }
    )).json();
    assert.ok(sysSub.directories.some((d) => d.name === 'MyMovies'));

    // Add MyMovies via API
    const addRes = await fetch(`${env.baseUrl}/api/roots/add`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: moviesDir, name: 'Movies Drive' }),
    });
    assert.equal(addRes.status, 200);
    const addData = await addRes.json();
    assert.equal(addData.roots.length, 1);
    assert.equal(addData.roots[0].name, 'Movies Drive');

    // Verify persistence in rootsFile
    const saved = JSON.parse(await fsp.readFile(env.rootsFile, 'utf8'));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, 'Movies Drive');

    // Verify listing works for newly added root
    const listData = await (await fetch(`${env.baseUrl}/api/list?root=${addData.roots[0].id}`, {
      headers: { Cookie: cookie },
    })).json();
    assert.equal(listData.total, 1);
    assert.equal(listData.items[0].name, 'film.mp4');

    // Remove root
    const rmRes = await fetch(`${env.baseUrl}/api/roots/remove`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: addData.roots[0].id }),
    });
    assert.equal(rmRes.status, 200);
    const rmData = await rmRes.json();
    assert.equal(rmData.roots.length, 0);
  } finally {
    await env.close();
  }
});

test('tunnel asset mapping and tunnel API endpoints', async () => {
  assert.equal(getDownloadAsset('linux', 'x64').file, 'cloudflared-linux-amd64');
  assert.equal(getDownloadAsset('win32', 'x64').file, 'cloudflared-windows-amd64.exe');
  assert.equal(getDownloadAsset('darwin', 'arm64').archive, true);

  let mockState = { status: 'stopped', url: null, error: null };
  const mockTunnel = {
    getStatus: () => ({ ...mockState }),
    start: async () => {
      mockState = { status: 'running', url: 'https://demo-test.trycloudflare.com', error: null };
      return { ...mockState };
    },
    stop: async () => {
      mockState = { status: 'stopped', url: null, error: null };
      return { ...mockState };
    },
  };

  const env = await createTestEnv({ tunnelManager: mockTunnel });
  try {
    const { cookie } = await login(env.baseUrl);

    const st0 = await (await fetch(`${env.baseUrl}/api/tunnel/status`, {
      headers: { Cookie: cookie },
    })).json();
    assert.equal(st0.status, 'stopped');

    const st1 = await (await fetch(`${env.baseUrl}/api/tunnel/start`, {
      method: 'POST',
      headers: { Cookie: cookie },
    })).json();
    assert.equal(st1.status, 'running');
    assert.equal(st1.url, 'https://demo-test.trycloudflare.com');

    const st2 = await (await fetch(`${env.baseUrl}/api/tunnel/stop`, {
      method: 'POST',
      headers: { Cookie: cookie },
    })).json();
    assert.equal(st2.status, 'stopped');
  } finally {
    await env.close();
  }
});

test('remote power control: opt-in flag, password check, readonly block, and OS command mapping', async () => {
  assert.equal(getPowerCommand('shutdown', 'win32').cmd, 'shutdown');
  assert.equal(getPowerCommand('restart', 'darwin').cmd, 'osascript');
  assert.equal(getPowerCommand('sleep', 'linux').cmd, 'systemctl');
  assert.throws(() => getPowerCommand('hibernate', 'linux'), /Invalid power action/);

  // Disabled by default
  const offEnv = await createTestEnv();
  try {
    const { cookie } = await login(offEnv.baseUrl);
    const statusOff = await (await fetch(`${offEnv.baseUrl}/api/auth/status`, { headers: { Cookie: cookie } })).json();
    assert.equal(statusOff.powerEnabled, false);

    const denied = await fetch(`${offEnv.baseUrl}/api/power`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sleep', password: 'test-pass' }),
    });
    assert.equal(denied.status, 403);
  } finally {
    await offEnv.close();
  }

  // Enabled with --allow-power and mocked powerRunner
  const triggered = [];
  const onEnv = await createTestEnv({
    allowPower: true,
    powerRunner: async (action) => {
      triggered.push(action);
      return { ok: true, action };
    },
  });
  try {
    const { cookie } = await login(onEnv.baseUrl);
    const statusOn = await (await fetch(`${onEnv.baseUrl}/api/auth/status`, { headers: { Cookie: cookie } })).json();
    assert.equal(statusOn.powerEnabled, true);

    const badPass = await fetch(`${onEnv.baseUrl}/api/power`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'shutdown', password: 'wrong' }),
    });
    assert.equal(badPass.status, 401);

    const okRes = await fetch(`${onEnv.baseUrl}/api/power`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'shutdown', password: 'test-pass' }),
    });
    assert.equal(okRes.status, 200);
    assert.deepEqual(triggered, ['shutdown']);

    const sysRes = await fetch(`${onEnv.baseUrl}/api/system/stats`, {
      headers: { Cookie: cookie },
    });
    assert.equal(sysRes.status, 200);
    const sysData = await sysRes.json();
    assert.ok(sysData.hostname);
    assert.ok(sysData.memory && sysData.memory.totalBytes > 0);
    assert.ok(Array.isArray(sysData.processes));
  } finally {
    await onEnv.close();
  }
});

