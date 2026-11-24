'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { disambiguateRootNames } = require('./config');

async function isReadableDir(dirPath) {
  try {
    const stat = await fsp.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Discover system drives and common starting directories across Windows, macOS, and Linux.
 */
async function getSystemQuickLocations() {
  const locations = [];
  const seen = new Set();

  async function addIfExists(label, targetPath) {
    const resolved = path.resolve(targetPath);
    if (seen.has(resolved)) return;
    if (await isReadableDir(resolved)) {
      seen.add(resolved);
      locations.push({ name: label, path: resolved });
    }
  }

  const home = os.homedir();
  await addIfExists(`Home (${path.basename(home) || home})`, home);

  for (const folder of ['Desktop', 'Documents', 'Downloads', 'Movies', 'Videos', 'Music', 'Pictures']) {
    await addIfExists(folder, path.join(home, folder));
  }

  if (process.platform === 'win32') {
    for (let code = 65; code <= 90; code++) {
      const drive = `${String.fromCharCode(code)}:\\`;
      await addIfExists(`Drive (${drive})`, drive);
    }
  } else {
    await addIfExists('Filesystem Root (/)', '/');
    const mountParents = process.platform === 'darwin'
      ? ['/Volumes']
      : ['/mnt', '/media', `/media/${os.userInfo().username}`];

    for (const parent of mountParents) {
      if (!(await isReadableDir(parent))) continue;
      try {
        const entries = await fsp.readdir(parent, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const full = path.join(parent, entry.name);
            await addIfExists(`Drive: ${entry.name}`, full);
          }
        }
      } catch {
        // Ignore unreadable mount parents
      }
    }
  }

  return locations;
}

/**
 * Browse host directories for the UI folder/drive picker.
 */
async function browseSystemDirs(dirPath = '') {
  if (!dirPath) {
    const locations = await getSystemQuickLocations();
    return {
      currentPath: '',
      parentPath: null,
      directories: locations,
    };
  }

  const resolved = path.resolve(dirPath);
  let realPath;
  try {
    realPath = await fsp.realpath(resolved);
    const stat = await fsp.stat(realPath);
    if (!stat.isDirectory()) {
      const err = new Error('Selected path is not a directory');
      err.statusCode = 400;
      throw err;
    }
  } catch (err) {
    if (!err.statusCode) {
      err = new Error(`Directory not accessible: ${resolved}`);
      err.statusCode = 404;
    }
    throw err;
  }

  const dirents = await fsp.readdir(realPath, { withFileTypes: true });
  const directories = [];
  for (const d of dirents) {
    if (d.isDirectory()) {
      directories.push({
        name: d.name,
        path: path.join(realPath, d.name),
      });
    }
  }

  directories.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  const parsed = path.parse(realPath);
  const parentPath = realPath === parsed.root ? '' : path.dirname(realPath);

  return {
    currentPath: realPath,
    parentPath,
    directories,
  };
}

async function persistRoots(config) {
  if (!config.rootsFile) return;
  const data = config.roots.map((r) => ({ name: r.baseName || r.name, path: r.path }));
  await fsp.mkdir(path.dirname(config.rootsFile), { recursive: true });
  await fsp.writeFile(config.rootsFile, JSON.stringify(data, null, 2), 'utf8');
}

async function addRoot(config, targetPath, customName = '') {
  if (!targetPath || typeof targetPath !== 'string') {
    const err = new Error('Missing directory path');
    err.statusCode = 400;
    throw err;
  }

  const resolved = path.resolve(targetPath.trim());
  let realPath;
  try {
    realPath = await fsp.realpath(resolved);
    const stat = await fsp.stat(realPath);
    if (!stat.isDirectory()) {
      const err = new Error('Path is not a directory');
      err.statusCode = 400;
      throw err;
    }
  } catch (err) {
    if (!err.statusCode) {
      err = new Error(`Directory does not exist: ${resolved}`);
      err.statusCode = 404;
    }
    throw err;
  }

  const existing = config.roots.find((r) => r.path === realPath);
  if (existing) {
    return { ok: true, root: existing, roots: serializeRoots(config.roots) };
  }

  const nextId = String(
    config.roots.reduce((max, r) => Math.max(max, parseInt(r.id, 10) || 0), -1) + 1
  );
  const baseName = (customName && String(customName).trim()) || path.basename(realPath) || realPath;

  const newRoot = {
    id: nextId,
    name: baseName,
    baseName,
    path: realPath,
  };

  config.roots.push(newRoot);
  disambiguateRootNames(config.roots);
  await persistRoots(config);

  return { ok: true, root: newRoot, roots: serializeRoots(config.roots) };
}

async function removeRoot(config, rootId) {
  const idx = config.roots.findIndex((r) => r.id === String(rootId));
  if (idx === -1) {
    const err = new Error('Shared folder not found');
    err.statusCode = 404;
    throw err;
  }
  config.roots.splice(idx, 1);
  disambiguateRootNames(config.roots);
  await persistRoots(config);
  return { ok: true, roots: serializeRoots(config.roots) };
}

function serializeRoots(roots) {
  return roots.map((r) => ({ id: r.id, name: r.name, path: r.path }));
}

module.exports = {
  browseSystemDirs,
  addRoot,
  removeRoot,
  serializeRoots,
};

