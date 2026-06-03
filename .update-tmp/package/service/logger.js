const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function createLogger(name) {
  const getFile = () => {
    const date = new Date().toISOString().slice(0, 10);
    return path.join(LOG_DIR, `${name}-${date}.log`);
  };

  const write = (level, msg) => {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    try {
      fs.appendFileSync(getFile(), line + '\n');
    } catch (e) {
      // ignore write errors
    }
    if (process.stdout && process.stdout.isTTY) {
      const fn = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log';
      console[fn](line);
    }
  };

  return {
    info: (msg) => write('INFO', msg),
    error: (msg) => write('ERROR', msg),
    warn: (msg) => write('WARN', msg)
  };
}

module.exports = { createLogger };