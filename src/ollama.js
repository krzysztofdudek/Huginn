const config = require("./config");

const URL = config.ollama.url || "http://localhost:11434";
const MODEL = config.ollama.model || "qwen3.5:4b";

let available = null;

async function check() {
  try {
    const res = await fetch(`${URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    available = res.ok;
  } catch { available = false; }
  return available;
}

async function chat(system, user, opts) {
  if (available === false) {
    const ok = await check();
    if (!ok) return null;
  }

  try {
    const res = await fetch(`${URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
        think: false,
        options: {
          temperature: (opts && opts.temperature) || 0.3,
          num_predict: (opts && opts.maxTokens) || 500,
        },
      }),
      signal: AbortSignal.timeout((opts && opts.timeout) || 60000),
    });

    if (!res.ok) {
      if (res.status === 404) available = false;
      return null;
    }

    available = true;
    const data = await res.json();
    return (data.message && data.message.content || "").trim() || null;
  } catch (err) {
    available = false;
    return null;
  }
}

function isAvailable() { return available !== false; }

module.exports = { check, chat, isAvailable };
