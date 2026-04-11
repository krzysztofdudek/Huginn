const config = require("./config");
const log = require("./logger");

const URL = config.ollama.url || "http://localhost:11434";

async function check() {
  try {
    const res = await fetch(`${URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function rawChat(model, system, user, opts) {
  const options = { temperature: opts.temperature || 0.3 };
  if (opts.topP != null) options.top_p = opts.topP;
  if (opts.topK != null) options.top_k = opts.topK;
  options.num_predict = opts.maxTokens || 500;

  const t = log.timer();

  try {
    const res = await fetch(`${URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
        ...(opts.think != null ? { think: opts.think } : {}),
        options,
      }),
      signal: AbortSignal.timeout(opts.timeout || 60000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.error(`Ollama HTTP ${res.status} for ${model}: ${body.slice(0, 150)}`);
      return null;
    }

    const data = await res.json();
    const content = (data.message && data.message.content || "").trim() || null;

    if (!content) {
      log.warn(`Ollama ${model}: empty response after ${t()}`);
    }

    return content;
  } catch (err) {
    if (err.name === "TimeoutError" || err.message.includes("timed out")) {
      log.warn(`Ollama ${model}: timeout after ${t()} (limit ${log.formatDuration(opts.timeout || 60000)})`);
    } else {
      log.error(`Ollama ${model}: ${err.message} after ${t()}`);
    }
    return null;
  }
}

module.exports = { check, rawChat };
