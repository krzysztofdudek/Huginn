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

  // Gemma tends to over-classify as relevant. This hint is appended to
  // classification prompts by the analyzer to counteract the bias.
  classifyHint: `A post merely MENTIONING a topic from the interests is NOT enough to be relevant or adjacent — it must share a novel tool, technique, finding, or actionable insight. Support requests, getting-started guides, showcase apps, opinion pieces without technical substance, and product announcements are IRRELEVANT. When uncertain between two categories, pick the less relevant one.`,

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
