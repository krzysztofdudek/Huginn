// src/insights.js
const fs = require("fs");
const path = require("path");
const db = require("./db");
const { getConnector, isAvailable } = require("./connectors");
const delivery = require("./delivery");
const config = require("./config");
const log = require("./logger");

// ── Auto-discover plugins ──

const plugins = {};
const dir = path.join(__dirname, "insights");
if (fs.existsSync(dir)) {
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".js")) continue;
    const plugin = require(path.join(dir, file));
    if (plugin.id && plugin.shouldRun && plugin.run && plugin.format) {
      plugins[plugin.id] = plugin;
    }
  }
}

function getEnabledPlugins() {
  const insightsConfig = config.insights || {};
  if (!insightsConfig.enabled) return [];
  const analyses = insightsConfig.analyses || {};
  return Object.values(plugins).filter((p) => {
    const ac = analyses[p.id];
    return !ac || ac.enabled !== false; // enabled by default
  });
}

// ── Scheduler ──

async function runDue() {
  const insightsConfig = config.insights || {};
  if (!insightsConfig.enabled) return;

  const maxPerCycle = insightsConfig.maxPerCycle || 3;
  const stuckTimeout = (insightsConfig.stuckTimeoutMinutes || 60) * 60;

  // 1. Recover stuck runs
  const recovered = db.recoverStuckRuns(stuckTimeout);
  if (recovered > 0) log.warn(`Recovered ${recovered} stuck insight run(s)`);

  // 2. For each enabled plugin, check shouldRun
  const enabled = getEnabledPlugins();
  let totalRun = 0;

  for (const plugin of enabled) {
    if (totalRun >= maxPerCycle) break;

    const lastRun = db.getLastAnalysisRun(plugin.id);
    let periods;
    try {
      periods = plugin.shouldRun(db, lastRun);
    } catch (err) {
      log.error(`${plugin.name}: shouldRun failed — ${err.message}`);
      continue;
    }

    if (!periods || periods.length === 0) continue;

    // Needs Ollama? Check availability
    if (plugin.needsOllama && !isAvailable()) continue;

    // Process periods sequentially, oldest first
    for (const period of periods) {
      if (totalRun >= maxPerCycle) break;

      const runId = db.startAnalysisRun(plugin.id, period.from, period.to);
      const t = log.timer();

      try {
        const connector = plugin.needsOllama ? getConnector() : null;
        const result = await plugin.run(db, connector, period, runId);

        if (result) {
          const summary = typeof result.summary === "string" ? result.summary : JSON.stringify(result).slice(0, 500);
          db.completeAnalysisRun(runId, summary);
          const formatted = plugin.format(result);
          if (formatted) {
            await delivery.deliverInsight(plugin.id, plugin.name, formatted);
            log.info(`${plugin.name}: alert sent ${log.c.dim}${t()}${log.c.reset}`);
          } else {
            log.dim(`  ${plugin.name}: completed ${log.c.dim}${t()}${log.c.reset}`);
          }
        } else {
          db.completeAnalysisRun(runId, null);
          log.dim(`  ${plugin.name}: no alert ${log.c.dim}${t()}${log.c.reset}`);
        }
      } catch (err) {
        db.failAnalysisRun(runId, err.message);
        log.error(`${plugin.name}: ${err.message} ${log.c.dim}${t()}${log.c.reset}`);
      }

      totalRun++;
    }
  }
}

// ── Dry run (--test-insights) ──

async function testAll() {
  const enabled = getEnabledPlugins();
  if (enabled.length === 0) {
    log.warn("No insights plugins enabled.");
    return;
  }

  log.heading("Insights dry run");
  console.log("");

  for (const plugin of enabled) {
    const lastRun = db.getLastAnalysisRun(plugin.id);
    let periods;
    try {
      periods = plugin.shouldRun(db, lastRun);
    } catch (err) {
      log.error(`${plugin.name}: shouldRun error — ${err.message}`);
      continue;
    }

    if (!periods || periods.length === 0) {
      log.dim(`  ${plugin.name}: nothing to run`);
      continue;
    }

    if (plugin.needsOllama && !isAvailable()) {
      log.warn(`${plugin.name}: needs Ollama but unavailable`);
      continue;
    }

    const period = periods[0];
    const spin = log.spinner(`${plugin.name}...`);
    try {
      const connector = plugin.needsOllama ? getConnector() : null;
      const result = await plugin.run(db, connector, period, null);
      if (result) {
        spin.done(`${plugin.name}`);
        console.log("");
        console.log(log.strip(plugin.format(result)));
        console.log("");
      } else {
        spin.done(`${plugin.name}: no findings`);
      }
    } catch (err) {
      spin.fail(`${plugin.name}: ${err.message}`);
    }
  }
}

module.exports = { runDue, testAll, getEnabledPlugins };
