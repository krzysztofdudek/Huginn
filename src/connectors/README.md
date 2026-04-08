# Connectors

Each file in this directory (except `index.js` and this README) is a connector for a specific Ollama model. The registry (`index.js`) auto-discovers them at startup.

## How it works

```
Consumer (analyzer, intelligence, etc.)
    |
    v
connectors/index.js  <-- picks active connector from config.ollama.connector
    |
    v
connectors/<model>.js  <-- model-specific defaults + post-processing
    |
    v
ollama.js  <-- raw HTTP calls to Ollama API
```

## Connector interface

Every connector exports an object with these fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique ID, matches `config.ollama.connector` value |
| `name` | `string` | Human-readable name for logs and diagnostics |
| `ollamaModel` | `string` | Exact model name in Ollama (e.g. `gemma4:e4b`) |
| `defaults` | `object` | Default sampling params: `temperature`, `topP`, `topK`, `maxTokens`, `timeout` |
| `chat(system, user, opts)` | `async function` | Send prompt, return `string \| null`. Merges defaults with opts (opts win). Post-processes response. |
| `check()` | `async function` | Verify Ollama is reachable. Returns `boolean`. |

## Adding a new connector

1. Create a new file: `src/connectors/<model-id>.js`
2. Export an object matching the interface above
3. Set `config.ollama.connector` to your connector's `id`
4. The registry picks it up automatically — no other changes needed

## What connectors encapsulate

- **Model name** — the exact Ollama model string
- **Default sampling parameters** — temperature, top_p, top_k (vary per model)
- **Response post-processing** — stripping thinking tokens, cleaning output format
- **Prompt modification** — if a model needs special system prompt tokens

## What connectors do NOT do

- No business logic (classification, briefing, summarization)
- No database access
- No delivery or formatting
- No retry logic (that's in the consumers)
