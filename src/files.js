'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MIME_TYPES = {
  // Video
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.3gp': 'video/3gpp',
  // Audio
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  // Images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  // Documents & Text
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  // Archives
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
};

const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.ts', '.3gp']);
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.flac']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.avif']);
const DOC_EXTS = new Set(['.pdf', '.txt', '.md', '.json', '.csv', '.log', '.srt', '.vtt', '.xml']);

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function getMediaCategory(name, isDir) {
  if (isDir) return 'folder';
  const ext = path.extname(name).toLowerCase();
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (DOC_EXTS.has(ext)) return 'doc';
  return 'file';
}

function isInsideRoot(rootPath, candidatePath) {
  const rel = path.relative(rootPath, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizeRelativeSegments(relPath = '') {
  const raw = String(relPath).replace(/\\/g, '/').trim();
  if (!raw || raw === '/') return [];
  const segments = raw.split('/').filter(Boolean);
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      const err = new Error('Invalid path segment');
      err.statusCode = 400;
      throw err;
    }
  }
  return segments;
}

/**
 * Resolve a root index + relative API path safely inside the configured root.
 */
async function resolveSafePath(roots, rootId = '0', relPath = '', { mustExist = true } = {}) {
  const root = roots.find((r) => r.id === String(rootId)) || roots[0];
  if (!root) {
    const err = new Error('Invalid storage root');
    err.statusCode = 400;
    throw err;
  }

  const segments = normalizeRelativeSegments(relPath);
  const joined = path.resolve(root.path, ...segments);

  if (!isInsideRoot(root.path, joined)) {
    const err = new Error('Path escapes storage root');
    err.statusCode = 403;
    throw err;
  }

  if (mustExist) {
    let real;
    try {
      real = await fsp.realpath(joined);
    } catch {
      const err = new Error('Path not found');
      err.statusCode = 404;
      throw err;
    }
    if (!isInsideRoot(root.path, real)) {
      const err = new Error('Symlink escapes storage root');
      err.statusCode = 403;
      throw err;
    }
    return { root, absPath: real, relPath: segments.join('/'), segments };
  }

  // For new targets, ensure the parent directory exists and stays inside root
  const parentDir = path.dirname(joined);
  let realParent;
  try {
    realParent = await fsp.realpath(parentDir);
  } catch {
    const err = new Error('Parent directory not found');
    err.statusCode = 404;
    throw err;
  }
  if (!isInsideRoot(root.path, realParent)) {
    const err = new Error('Parent path escapes storage root');
    err.statusCode = 403;
    throw err;
  }

  return {
    root,
    absPath: path.join(realParent, path.basename(joined)),
    relPath: segments.join('/'),
    segments,
  };
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < items.length) {
      const i = nextIdx++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * List directory contents with search, category filter, sorting, and pagination.
 */
async function listDirectory(roots, query) {
  const {
    root = '0',
    path: relPath = '',
    search = '',
    type = 'all',
    sort = 'name',
    order = 'asc',
    page = '1',
    limit = '100',
  } = query;

  const resolved = await resolveSafePath(roots, root, relPath, { mustExist: true });
  const targetStat = await fsp.stat(resolved.absPath);
  if (!targetStat.isDirectory()) {
    const err = new Error('Target is not a directory');
    err.statusCode = 400;
    throw err;
  }

  const dirents = await fsp.readdir(resolved.absPath, { withFileTypes: true });
  const searchLower = String(search).trim().toLowerCase();

  // Filter by search & type before stat-ing when possible
  const preFiltered = dirents.filter((d) => {
    if (searchLower && !d.name.toLowerCase().includes(searchLower)) {
      return false;
    }
    if (type !== 'all') {
      const cat = getMediaCategory(d.name, d.isDirectory());
      if (cat !== type && !(type === 'folder' && d.isDirectory())) {
        return false;
      }
    }
    return true;
  });

  const entries = await mapWithConcurrency(preFiltered, 64, async (dirent) => {
    const fullPath = path.join(resolved.absPath, dirent.name);
    let stat = null;
    let isDir = dirent.isDirectory();
    try {
      stat = await fsp.stat(fullPath);
      isDir = stat.isDirectory();
    } catch {
      // Skip broken symlinks or unreadable entries
      return null;
    }
    const itemRel = resolved.relPath ? `${resolved.relPath}/${dirent.name}` : dirent.name;
    return {
      name: dirent.name,
      path: itemRel,
      isDir,
      category: getMediaCategory(dirent.name, isDir),
      size: isDir ? 0 : stat.size,
      mtime: stat.mtimeMs,
      mime: isDir ? 'inode/directory' : getMimeType(dirent.name),
    };
  });

  const validEntries = entries.filter(Boolean);
  const dirFactor = order === 'desc' ? -1 : 1;

  validEntries.sort((a, b) => {
    // Always keep folders grouped before files
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let cmp = 0;
    if (sort === 'size') {
      cmp = a.size - b.size;
    } else if (sort === 'mtime') {
      cmp = a.mtime - b.mtime;
    } else if (sort === 'type') {
      cmp = a.category.localeCompare(b.category) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    } else {
      cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    }
    return cmp * dirFactor;
  });

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  const total = validEntries.length;
  const totalPages = Math.max(1, Math.ceil(total / limitNum));
  const safePage = Math.min(pageNum, totalPages);
  const startIdx = (safePage - 1) * limitNum;
  const items = validEntries.slice(startIdx, startIdx + limitNum);

  const breadcrumbs = [{ name: resolved.root.name, path: '' }];
  let acc = '';
  for (const seg of resolved.segments) {
    acc = acc ? `${acc}/${seg}` : seg;
    breadcrumbs.push({ name: seg, path: acc });
  }

  return {
    root: { id: resolved.root.id, name: resolved.root.name },
    roots: roots.map((r) => ({ id: r.id, name: r.name })),
    path: resolved.relPath,
    breadcrumbs,
    items,
    total,
    page: safePage,
    limit: limitNum,
    totalPages,
  };
}

/**
 * Stream a file with full HTTP Range (206 Partial Content) support.
 */
async function streamFile(req, res, roots, query, { download = false } = {}) {
  const { root = '0', path: relPath = '' } = query;
  const resolved = await resolveSafePath(roots, root, relPath, { mustExist: true });
  const stat = await fsp.stat(resolved.absPath);
  if (!stat.isFile()) {
    const err = new Error('Target is not a file');
    err.statusCode = 400;
    throw err;
  }

  const totalSize = stat.size;
  const mime = getMimeType(resolved.absPath);
  const filename = path.basename(resolved.absPath);
  const disposition = download ? 'attachment' : 'inline';
  const encodedName = encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, '%2A');

  const baseHeaders = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encodedName}`,
    'Cache-Control': 'private, max-age=3600',
  };

  const rangeHeader = req.headers.range;
  if (rangeHeader && totalSize > 0) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
      res.end();
      return;
    }

    let start = match[1] ? parseInt(match[1], 10) : 0;
    let end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

    if (!match[1] && match[2]) {
      // Suffix range: bytes=-N (last N bytes)
      const suffix = parseInt(match[2], 10);
      start = Math.max(0, totalSize - suffix);
      end = totalSize - 1;
    }

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= totalSize) {
      res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
      res.end();
      return;
    }

    end = Math.min(end, totalSize - 1);
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Content-Length': chunkSize,
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(resolved.absPath, { start, end });
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.destroy();
    });
    stream.pipe(res);
    return;
  }

  res.writeHead(200, {
    ...baseHeaders,
    'Content-Length': totalSize,
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(resolved.absPath);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.destroy();
  });
  stream.pipe(res);
}

// --- Chunked Upload Manager ---

function createUploadManager(roots) {
  const tempRoot = path.join(os.tmpdir(), 'storage-server-uploads');
  const sessions = new Map();

  function validateFileName(name) {
    if (!name || typeof name !== 'string') {
      const err = new Error('Missing filename');
      err.statusCode = 400;
      throw err;
    }
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      const err = new Error('Invalid filename');
      err.statusCode = 400;
      throw err;
    }
    return name;
  }

  async function initUpload({ root = '0', path: dirPath = '', filename, totalChunks, totalSize }) {
    const safeName = validateFileName(filename);
    const targetRel = dirPath ? `${dirPath}/${safeName}` : safeName;
    const resolved = await resolveSafePath(roots, root, targetRel, { mustExist: false });

    const chunksCount = parseInt(totalChunks, 10);
    if (!Number.isInteger(chunksCount) || chunksCount < 1 || chunksCount > 100000) {
      const err = new Error('Invalid totalChunks');
      err.statusCode = 400;
      throw err;
    }

    const uploadId = crypto.randomBytes(16).toString('hex');
    const sessionDir = path.join(tempRoot, uploadId);
    await fsp.mkdir(sessionDir, { recursive: true });

    sessions.set(uploadId, {
      uploadId,
      sessionDir,
      targetPath: resolved.absPath,
      totalChunks: chunksCount,
      totalSize: Number(totalSize) || 0,
      received: new Set(),
      createdAt: Date.now(),
    });

    return { uploadId };
  }

  async function receiveChunk(req, { uploadId, index }) {
    const session = sessions.get(uploadId);
    if (!session) {
      const err = new Error('Upload session not found');
      err.statusCode = 404;
      throw err;
    }

    const idx = parseInt(index, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= session.totalChunks) {
      const err = new Error('Invalid chunk index');
      err.statusCode = 400;
      throw err;
    }

    const chunkPath = path.join(session.sessionDir, `chunk_${idx}`);
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(chunkPath);
      req.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      req.on('error', reject);
    });

    session.received.add(idx);
    return { received: session.received.size, totalChunks: session.totalChunks };
  }

  async function completeUpload({ uploadId }) {
    const session = sessions.get(uploadId);
    if (!session) {
      const err = new Error('Upload session not found');
      err.statusCode = 404;
      throw err;
    }

    if (session.received.size !== session.totalChunks) {
      const err = new Error(`Missing chunks (${session.received.size}/${session.totalChunks})`);
      err.statusCode = 400;
      throw err;
    }

    const partTarget = `${session.targetPath}.part-${uploadId}`;
    try {
      const out = fs.createWriteStream(partTarget);
      for (let i = 0; i < session.totalChunks; i++) {
        const chunkPath = path.join(session.sessionDir, `chunk_${i}`);
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(chunkPath);
          rs.on('error', reject);
          rs.on('end', resolve);
          rs.pipe(out, { end: false });
        });
      }
      await new Promise((resolve, reject) => {
        out.end(resolve);
        out.on('error', reject);
      });
      await fsp.rename(partTarget, session.targetPath);
    } catch (err) {
      await fsp.rm(partTarget, { force: true }).catch(() => {});
      throw err;
    } finally {
      sessions.delete(uploadId);
      await fsp.rm(session.sessionDir, { recursive: true, force: true }).catch(() => {});
    }

    return { ok: true };
  }

  async function cancelUpload({ uploadId }) {
    const session = sessions.get(uploadId);
    if (!session) return { ok: true };
    sessions.delete(uploadId);
    await fsp.rm(session.sessionDir, { recursive: true, force: true }).catch(() => {});
    return { ok: true };
  }

  return { initUpload, receiveChunk, completeUpload, cancelUpload };
}

async function createFolder(roots, { root = '0', path: dirPath = '', name }) {
  if (!name || typeof name !== 'string' || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    const err = new Error('Invalid folder name');
    err.statusCode = 400;
    throw err;
  }
  const targetRel = dirPath ? `${dirPath}/${name}` : name;
  const resolved = await resolveSafePath(roots, root, targetRel, { mustExist: false });
  await fsp.mkdir(resolved.absPath, { recursive: false });
  return { ok: true, path: resolved.relPath };
}

async function renameItem(roots, { root = '0', path: oldRelPath, newName }) {
  if (!newName || typeof newName !== 'string' || newName.includes('/') || newName.includes('\\') || newName === '.' || newName === '..') {
    const err = new Error('Invalid new name');
    err.statusCode = 400;
    throw err;
  }
  const oldResolved = await resolveSafePath(roots, root, oldRelPath, { mustExist: true });
  if (!oldResolved.relPath) {
    const err = new Error('Cannot rename root directory');
    err.statusCode = 400;
    throw err;
  }
  const parentRel = oldResolved.segments.slice(0, -1).join('/');
  const newRel = parentRel ? `${parentRel}/${newName}` : newName;
  const newResolved = await resolveSafePath(roots, root, newRel, { mustExist: false });
  await fsp.rename(oldResolved.absPath, newResolved.absPath);
  return { ok: true, path: newResolved.relPath };
}

async function deleteItem(roots, { root = '0', path: targetRel }) {
  const resolved = await resolveSafePath(roots, root, targetRel, { mustExist: true });
  if (!resolved.relPath) {
    const err = new Error('Cannot delete root directory');
    err.statusCode = 400;
    throw err;
  }
  await fsp.rm(resolved.absPath, { recursive: true, force: false });
  return { ok: true };
}

module.exports = {
  listDirectory,
  streamFile,
  createUploadManager,
  createFolder,
  renameItem,
  deleteItem,
  resolveSafePath,
  getMimeType,
};

