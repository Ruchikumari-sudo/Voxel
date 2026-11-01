// Generates config.js from client/.env (run: node build-config.js). Only public values belong here.
const fs = require('fs'), env = {};
for (const l of fs.readFileSync(__dirname + '/.env', 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
fs.writeFileSync(__dirname + '/config.js', 'window.VOXEL_CONFIG=' + JSON.stringify({ API_BASE: env.VOXEL_API_BASE || '', TILE_URL: env.VOXEL_TILE_URL || '' }) + ';\n');
console.log('config.js written');
