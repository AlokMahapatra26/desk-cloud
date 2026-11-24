'use strict';

const { execFile } = require('child_process');

const VALID_ACTIONS = new Set(['shutdown', 'restart', 'sleep']);

const POWER_COMMANDS = {
  win32: {
    shutdown: ['shutdown', ['/s', '/t', '3']],
    restart: ['shutdown', ['/r', '/t', '3']],
    sleep: ['rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']],
  },
  darwin: {
    shutdown: ['osascript', ['-e', 'tell app "System Events" to shut down']],
    restart: ['osascript', ['-e', 'tell app "System Events" to restart']],
    sleep: ['pmset', ['sleepnow']],
  },
  linux: {
    shutdown: ['systemctl', ['poweroff']],
    restart: ['systemctl', ['reboot']],
    sleep: ['systemctl', ['suspend']],
  },
};

/**
 * Resolve the OS command and arguments for a power action.
 */
function getPowerCommand(action, platform = process.platform) {
  if (!VALID_ACTIONS.has(action)) {
    const err = new Error('Invalid power action. Must be shutdown, restart, or sleep.');
    err.statusCode = 400;
    throw err;
  }
  const table = POWER_COMMANDS[platform] || POWER_COMMANDS.linux;
  const [cmd, args] = table[action];
  return { cmd, args };
}

/**
 * Schedule an OS power action shortly after returning the HTTP response.
 */
function executePowerAction(action, { delayMs = 350, platform = process.platform } = {}) {
  const { cmd, args } = getPowerCommand(action, platform);
  const timer = setTimeout(() => {
    execFile(cmd, args, (err) => {
      if (err) {
        console.error(`Power action "${action}" failed:`, err.message);
      }
    });
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { ok: true, action };
}

module.exports = { VALID_ACTIONS, getPowerCommand, executePowerAction };

