const fs = require("fs");
const path = require("path");
const config = require("../config");

// Auto-discover connectors: all .js files in this directory except index.js
const connectors = {};
const dir = __dirname;
for (const file of fs.readdirSync(dir)) {
  if (file === "index.js" || !file.endsWith(".js")) continue;
  const connector = require(path.join(dir, file));
  if (connector.id && connector.chat && connector.check) {
    connectors[connector.id] = connector;
  }
}

const connectorId = config.ollama.connector || "qwen-3.5-9b";

if (!connectors[connectorId]) {
  const available = Object.keys(connectors).join(", ");
  console.error(`\x1b[31m\u2717\x1b[0m Unknown connector "${connectorId}". Available: ${available}`);
  process.exit(1);
}

const active = connectors[connectorId];
let available = null;

function getConnector() {
  return active;
}

function listConnectors() {
  return Object.values(connectors).map((c) => ({
    id: c.id,
    name: c.name,
    ollamaModel: c.ollamaModel,
  }));
}

async function check() {
  const ok = await active.check();
  available = ok;
  return ok;
}

function isAvailable() {
  return available !== false;
}

module.exports = { getConnector, listConnectors, check, isAvailable };
