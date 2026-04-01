const db = require("./db");

function rebuild() {
  db.rebuildPeople();
}

function getTopVoices(limit) {
  return db.getTopPeople(limit || 20);
}

module.exports = { rebuild, getTopVoices };
