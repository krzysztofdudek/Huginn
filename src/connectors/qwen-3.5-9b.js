const ollama = require("../ollama");

function stripThinking(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

const connector = {
  id: "qwen-3.5-9b",
  name: "Qwen 3.5 9B",
  ollamaModel: "qwen3.5:9b",

  defaults: {
    temperature: 0.3,
    maxTokens: 500,
    timeout: 60000,
  },

  async chat(system, user, opts) {
    const merged = { ...this.defaults, ...opts };
    const result = await ollama.rawChat(this.ollamaModel, system, user, merged);
    return stripThinking(result);
  },

  async check() {
    return ollama.check();
  },
};

module.exports = connector;
