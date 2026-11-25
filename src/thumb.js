'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { resolveSafePath, getMimeType } = require('./files');

const execFileAsync = promisify(execFile);
const THUMB_DIR = path.join(os.homedir(), '.storage-server', 'thumbs');
const MAX_CONCURRENT = 3;

let ffmpegChecked = false;
let hasFfmpeg = false;
let activeJobs = 0;
const waitQueue = [];
const inflightMap = new Map();

async function checkFfmpeg() {
  if (ffmpegChecked) return hasFfmpeg;
  ffmpegChecked = true;
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 3000 });
    hasFfmpeg = true;
  } catch {
    hasFfmpeg = false;
  }
  return hasFfmpeg;
}

function acquireSlot() {
  if (activeJobs < MAX_CONCURRENT) {
    activeJobs++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}

function releaseSlot() {
  activeJobs--;
  if (waitQueue.length > 0) {
    activeJobs++;
    const next = waitQueue.shift();
    next();
  }
}

async function generateWithFfmpeg(absPath, outPath, isVideo) {
  const tmpPath = `${outPath}.${crypto.randomBytes(6).toString('hex')}.tmp.jpg`;
  const run = async (args) => {
    await execFileAsync('ffmpeg', args, { timeout: 12000 });
  };
  try {
    if (isVideo) {
      try {
        await run(['-y', '-ss', '00:00:01', '-i', absPath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '6', tmpPath]);
      } catch {
        await run(['-y', '-i', absPath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '6', tmpPath]);
      }
    } else {
      await run(['-y', '-i', absPath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '6', tmpPath]);
    }
    await fsp.rename(tmpPath, outPath);
    return true;
  } catch {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    return false;
  }
}

async function ensureThumbnail(absPath, stat, isVideo) {
  const key = crypto
    .createHash('sha256')
    .update(`${absPath}:${stat.mtimeMs}:${stat.size}`)
    .digest('hex');
  const outPath = path.join(THUMB_DIR, `${key}.jpg`);

  if (fs.existsSync(outPath)) {
    return outPath;
  }

  if (inflightMap.has(key)) {
    return inflightMap.get(key);
  }

  const job = (async () => {
    await fsp.mkdir(THUMB_DIR, { recursive: true });
    await acquireSlot();
    try {
      if (fs.existsSync(outPath)) return outPath;
      if (!(await checkFfmpeg())) return null;
      const ok = await generateWithFfmpeg(absPath, outPath, isVideo);
      return ok ? outPath : null;
    } finally {
      releaseSlot();
      inflightMap.delete(key);
    }
  })();

  inflightMap.set(key, job);
  return job;
}

/**
 * Serve a small, disk-cached JPEG thumbnail for images and videos.
 */
async function serveThumbnail(req, res, roots, query) {
  const { root = '0', path: relPath = '' } = query;
  const resolved = await resolveSafePath(roots, root, relPath, { mustExist: true });
  const stat = await fsp.stat(resolved.absPath);
  if (!stat.isFile()) {
    res.writeHead(404);
    res.end();
    return;
  }

  const mime = getMimeType(resolved.absPath);
  const isVideo = mime.startsWith('video/');
  const isImage = mime.startsWith('image/');
  if (!isVideo && !isImage) {
    res.writeHead(404);
    res.end();
    return;
  }

  const thumbPath = await ensureThumbnail(resolved.absPath, stat, isVideo);
  if (thumbPath && fs.existsSync(thumbPath)) {
    const tStat = await fsp.stat(thumbPath);
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': tStat.size,
      'Cache-Control': 'private, max-age=86400',
    });
    fs.createReadStream(thumbPath).pipe(res);
    return;
  }

  // Fallback for small images when ffmpeg isn't installed
  if (isImage && stat.size <= 1500 * 1024) {
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': 'private, max-age=86400',
    });
    fs.createReadStream(resolved.absPath).pipe(res);
    return;
  }

  res.writeHead(404);
  res.end();
}

module.exports = { serveThumbnail };

