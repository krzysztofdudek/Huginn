const config = require("./config");

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

    if (!res.ok) return null;

    const data = await res.json();
    return (data.message && data.message.content || "").trim() || null;
  } catch {
    return null;
  }
}

module.exports = { check, rawChat };
