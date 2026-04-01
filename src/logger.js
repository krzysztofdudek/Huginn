const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "..", "data");
const LOG_FILE = path.join(LOG_DIR, "newsvision.log");

let logStream = null;

function init() {
  if (logStream) return;
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

  // Mirror console to log file (strip ANSI codes)
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
  const ts = () => new Date().toISOString();

  console.log = (...args) => {
    origLog(...args);
    if (logStream) logStream.write(ts() + " " + args.map(strip).join(" ") + "\n");
  };

  console.error = (...args) => {
    origError(...args);
    if (logStream) logStream.write(ts() + " ERROR " + args.map(strip).join(" ") + "\n");
  };

  console.warn = (...args) => {
    origWarn(...args);
    if (logStream) logStream.write(ts() + " WARN " + args.map(strip).join(" ") + "\n");
  };
}

function close() {
  if (logStream) { logStream.end(); logStream = null; }
}

module.exports = { init, close };
