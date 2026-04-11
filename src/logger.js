const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "..", "data");
const LOG_FILE = path.join(LOG_DIR, "huginn.log");

// ── ANSI Colors ──

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
  orange: "\x1b[38;5;208m",
};

const SPINNER_CHARS = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];

// ── Log file ──

let logStream = null;

function init() {
  if (logStream) return;
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
}

function close() {
  if (logStream) { logStream.end(); logStream = null; }
}

function strip(text) {
  return String(text || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function writeLog(level, msg) {
  if (!logStream) return;
  const clean = strip(msg).trim();
  if (clean) {
    logStream.write(`${new Date().toISOString()} ${level.padEnd(5)} ${clean}\n`);
  }
}

// ── Formatting helpers ──

function ts() {
  return new Date().toLocaleTimeString("en-US", {
    hour12: true, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = Math.round((ms % 60000) / 1000);
  return `${min}m${sec}s`;
}

function formatNumber(n) {
  return n.toLocaleString("en-US");
}

// ── Log functions ──

function info(msg) {
  const line = `  ${c.dim}${ts()}${c.reset} ${msg}`;
  console.log(line);
  writeLog("INFO", msg);
}

function success(msg) {
  const line = `  ${c.green}\u2713${c.reset} ${msg}`;
  console.log(line);
  writeLog("OK", msg);
}

function warn(msg) {
  const line = `  ${c.yellow}\u26a0${c.reset} ${c.yellow}${msg}${c.reset}`;
  console.warn(line);
  writeLog("WARN", msg);
}

function error(msg) {
  const line = `  ${c.red}\u2717${c.reset} ${c.red}${msg}${c.reset}`;
  console.error(line);
  writeLog("ERROR", msg);
}

function phase(name) {
  const rule = "\u2500".repeat(Math.max(0, 50 - name.length));
  console.log(`\n  ${c.bold}${name}${c.reset} ${c.dim}${rule}${c.reset}`);
  writeLog("-----", name);
}

function dim(msg) {
  console.log(`  ${c.dim}${msg}${c.reset}`);
  writeLog("INFO", msg);
}

function raw(msg) {
  console.log(msg);
  writeLog("INFO", msg);
}

// ── Spinner ──

function spinner(text) {
  let frame = 0;
  let current = text;
  const start = Date.now();

  const interval = setInterval(() => {
    frame = (frame + 1) % SPINNER_CHARS.length;
    process.stdout.write(`\r  ${c.cyan}${SPINNER_CHARS[frame]}${c.reset} ${current}  `);
  }, 80);

  process.stdout.write(`  ${c.cyan}${SPINNER_CHARS[0]}${c.reset} ${current}`);

  function elapsed() {
    return formatDuration(Date.now() - start);
  }

  return {
    update(newText) { current = newText; },

    done(doneText) {
      clearInterval(interval);
      const dur = elapsed();
      const line = `${doneText} ${c.dim}${dur}${c.reset}`;
      process.stdout.write(`\r  ${c.green}\u2713${c.reset} ${line}\x1b[K\n`);
      writeLog("OK", `${doneText} (${dur})`);
    },

    fail(failText) {
      clearInterval(interval);
      const dur = elapsed();
      const line = `${failText} ${c.dim}${dur}${c.reset}`;
      process.stdout.write(`\r  ${c.red}\u2717${c.reset} ${c.red}${line}${c.reset}\x1b[K\n`);
      writeLog("ERROR", `${failText} (${dur})`);
    },

    warn(warnText) {
      clearInterval(interval);
      const dur = elapsed();
      const line = `${warnText} ${c.dim}${dur}${c.reset}`;
      process.stdout.write(`\r  ${c.yellow}\u26a0${c.reset} ${c.yellow}${line}${c.reset}\x1b[K\n`);
      writeLog("WARN", `${warnText} (${dur})`);
    },
  };
}

// ── Timer ──

function timer() {
  const start = Date.now();
  return function elapsed() {
    return formatDuration(Date.now() - start);
  };
}

// ── Probe (for --test style checks) ──

function probe(label) {
  process.stdout.write(`  ${c.dim}\u25cb${c.reset} ${label}... `);

  return {
    ok(detail) {
      console.log(`${c.green}OK${c.reset}${detail ? ` ${c.dim}(${detail})${c.reset}` : ""}`);
      writeLog("OK", `${label}: ${detail || "OK"}`);
    },
    fail(detail) {
      console.log(`${c.red}FAIL${c.reset}${detail ? ` ${c.dim}(${detail})${c.reset}` : ""}`);
      writeLog("ERROR", `${label}: ${detail || "FAIL"}`);
    },
    skip(detail) {
      console.log(`${c.yellow}SKIP${c.reset}${detail ? ` ${c.dim}(${detail})${c.reset}` : ""}`);
      writeLog("WARN", `${label}: ${detail || "SKIP"}`);
    },
  };
}

// ── Table (for --status) ──

function kvLine(key, value) {
  console.log(`  ${c.dim}${key}:${c.reset} ${value}`);
}

function heading(text) {
  console.log(`\n  ${c.bold}${text}${c.reset}`);
}

module.exports = {
  init, close,
  info, success, warn, error, phase, dim, raw,
  spinner, timer, probe, kvLine, heading,
  formatDuration, formatNumber, strip,
  c,
};
