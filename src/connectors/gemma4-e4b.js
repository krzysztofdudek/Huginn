const ollama = require("../ollama");

function stripThinking(text) {
  if (!text) return text;
  // Gemma 4 thinking format: <|channel>thought\n...<channel|>
  return text.replace(/<\|channel>thought\n[\s\S]*?<channel\|>/g, "").trim();
}

const connector = {
  id: "gemma4-e4b",
  name: "Gemma 4 E4B",
  ollamaModel: "gemma4:e4b",

  defaults: {
    temperature: 1.0,
    topP: 0.95,
    topK: 64,
    maxTokens: 500,
    timeout: 60000,
    think: false,
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
