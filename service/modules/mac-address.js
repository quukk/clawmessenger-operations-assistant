const os = require('os');

function getMacAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.mac.replace(/:/g, '').toLowerCase();
      }
    }
  }
  return 'unknown';
}

module.exports = { getMacAddress };
