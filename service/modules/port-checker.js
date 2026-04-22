const net = require('net');

function checkPortListening(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(3000);
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    sock.connect(port, '127.0.0.1');
  });
}

async function getOpenClawStatus(port = 18789) {
  const isListening = await checkPortListening(port);
  return isListening ? 1 : 0;
}

module.exports = {
  checkPortListening,
  getOpenClawStatus,
};
