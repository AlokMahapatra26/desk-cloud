'use strict';

const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

let prevCpuTimes = null;
let lastCpuPct = 0;

function sampleCpuPct() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
  }
  if (prevCpuTimes) {
    const dIdle = idle - prevCpuTimes.idle;
    const dTotal = total - prevCpuTimes.total;
    if (dTotal > 0) {
      lastCpuPct = Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10;
    }
  }
  prevCpuTimes = { idle, total };
  return lastCpuPct;
}

async function getMemoryInfo() {
  const totalBytes = os.totalmem();
  let freeBytes = os.freemem();

  if (process.platform === 'linux') {
    try {
      const meminfo = await fsp.readFile('/proc/meminfo', 'utf8');
      const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
      if (match) {
        freeBytes = parseInt(match[1], 10) * 1024;
      }
    } catch {
      // Fallback to os.freemem()
    }
  }

  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const usedPct = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;
  return { totalBytes, usedBytes, freeBytes, usedPct };
}

async function getDisks() {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          'Get-PSDrive -PSProvider FileSystem | Where-Object {$_.Used -ne $null -or $_.Free -ne $null} | Select-Object Root,Used,Free | ConvertTo-Json',
        ],
        { timeout: 4000 }
      );
      const parsed = JSON.parse(stdout || '[]');
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr
        .filter((d) => d && d.Root)
        .map((d) => {
          const used = Number(d.Used) || 0;
          const free = Number(d.Free) || 0;
          const total = used + free;
          return {
            mount: d.Root,
            totalBytes: total,
            usedBytes: used,
            freeBytes: free,
            usedPct: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
          };
        });
    } catch {
      return [];
    }
  }

  try {
    const { stdout } = await execFileAsync('df', ['-kP'], { timeout: 3000 });
    const lines = stdout.trim().split('\n').slice(1);
    const seen = new Set();
    const disks = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const fsName = parts[0];
      const totalKb = parseInt(parts[1], 10);
      const usedKb = parseInt(parts[2], 10);
      const availKb = parseInt(parts[3], 10);
      const mount = parts.slice(5).join(' ');
      if (!Number.isFinite(totalKb) || totalKb <= 0) continue;
      if (fsName === 'tmpfs' || fsName === 'devtmpfs' || fsName === 'udev' || mount.startsWith('/snap')) continue;
      if (seen.has(mount)) continue;
      seen.add(mount);
      const totalBytes = totalKb * 1024;
      const usedBytes = usedKb * 1024;
      const freeBytes = availKb * 1024;
      disks.push({
        mount,
        totalBytes,
        usedBytes,
        freeBytes,
        usedPct: Math.round((usedBytes / totalBytes) * 1000) / 10,
      });
    }
    return disks;
  } catch {
    return [];
  }
}

async function getTopProcesses(limit = 15) {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First ${limit} Id,ProcessName,CPU,WorkingSet64 | ConvertTo-Json`,
        ],
        { timeout: 4000 }
      );
      const parsed = JSON.parse(stdout || '[]');
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr
        .filter((p) => p && p.ProcessName)
        .map((p) => ({
          pid: p.Id,
          name: p.ProcessName,
          cpuPct: typeof p.CPU === 'number' ? Math.round(p.CPU * 10) / 10 : 0,
          memPct: 0,
          memBytes: Number(p.WorkingSet64) || 0,
        }));
    } catch {
      return [];
    }
  }

  try {
    const args =
      process.platform === 'darwin'
        ? ['-eo', 'pid,comm,%cpu,%mem,rss', '-r']
        : ['-eo', 'pid,comm,%cpu,%mem,rss', '--sort=-%cpu'];
    const { stdout } = await execFileAsync('ps', args, { timeout: 3000 });
    const lines = stdout.trim().split('\n').slice(1, limit + 1);
    const procs = [];
    for (const line of lines) {
      const m = /^\s*(\d+)\s+(.+?)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s*$/.exec(line);
      if (!m) continue;
      procs.push({
        pid: parseInt(m[1], 10),
        name: m[2].trim(),
        cpuPct: parseFloat(m[3]) || 0,
        memPct: parseFloat(m[4]) || 0,
        memBytes: (parseInt(m[5], 10) || 0) * 1024,
      });
    }
    return procs;
  } catch {
    return [];
  }
}

async function getSystemStats() {
  const cpus = os.cpus();
  const [memory, disks, processes] = await Promise.all([
    getMemoryInfo(),
    getDisks(),
    getTopProcesses(15),
  ]);

  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    uptimeSec: Math.floor(os.uptime()),
    cpu: {
      cores: cpus.length,
      model: cpus[0]?.model?.trim() || 'CPU',
      loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
      usagePct: sampleCpuPct(),
    },
    memory,
    disks,
    processes,
  };
}

module.exports = { getSystemStats };

