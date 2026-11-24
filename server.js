#!/usr/bin/env node
'use strict';

const http = require('http');
const os = require('os');
const { parseConfig, HELP_TEXT } = require('./src/config');
const { createRequestHandler } = require('./src/router');
const { createTunnelManager } = require('./src/tunnel');

function getLanAddresses() {
  const ifaces = os.networkInterfaces();
  const addrs = [];
  for (const list of Object.values(ifaces)) {
    for (const info of list || []) {
      if (info.family === 'IPv4' && !info.internal) {
        addrs.push(info.address);
      }
    }
  }
  return addrs;
}

function startServer(config, options = {}) {
  let boundPort = config.port;
  const tunnelManager =
    options.tunnelManager || createTunnelManager({ getPort: () => boundPort });
  const handler = createRequestHandler(config, {
    tunnelManager,
    powerRunner: options.powerRunner,
  });
  const server = http.createServer(handler);
  server.tunnelManager = tunnelManager;
  // Allow long-running video streams and large chunked uploads
  server.requestTimeout = 0;
  server.headersTimeout = 60 * 1000;

  server.on('close', () => {
    tunnelManager.stop().catch(() => {});
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(config.port, config.host, () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) boundPort = addr.port;
      resolve(server);
    });
  });
}

if (require.main === module) {
  let config;
  try {
    config = parseConfig();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.error('Run with --help for usage.');
    process.exit(1);
  }

  if (config.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  startServer(config)
    .then((server) => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : config.port;
      const lanIps = getLanAddresses();

      console.log('');
      console.log('====================================================');
      console.log('  DeskCloud is running!');
      console.log('====================================================');
      console.log(`  Local URL : http://localhost:${port}`);
      for (const ip of lanIps) {
        console.log(`  LAN URL   : http://${ip}:${port}`);
      }
      console.log('');
      console.log('  Shared folders:');
      if (config.roots.length === 0) {
        console.log('    (none yet — open the Web UI to add folders or drives)');
      } else {
        for (const r of config.roots) {
          console.log(`    [${r.id}] ${r.name} -> ${r.path}`);
        }
      }
      console.log('');
      if (config.authEnabled) {
        console.log(
          `  Password  : ${config.password}${config.generatedPassword ? ' (auto-generated)' : ''}`
        );
      } else {
        console.log('  Auth      : DISABLED (--no-auth)');
      }
      if (config.readonly) {
        console.log('  Mode      : READ-ONLY');
      }
      console.log('');
      if (config.tunnel) {
        console.log('  Starting Cloudflare Tunnel...');
        server.tunnelManager
          .start()
          .then((st) => {
            console.log(`  Public URL: ${st.url}`);
            console.log('====================================================');
            console.log('');
          })
          .catch((err) => {
            console.error(`  Tunnel failed: ${err.message}`);
            console.log('====================================================');
            console.log('');
          });
      } else {
        console.log('  Expose anywhere with Cloudflare Tunnel:');
        console.log(`    node server.js --tunnel`);
        console.log('    (or click "🌐 Go Public" inside the Web UI)');
        console.log('====================================================');
        console.log('');
      }

      const shutdown = () => {
        server.close(() => process.exit(0));
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error(`Failed to start server: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { startServer };

