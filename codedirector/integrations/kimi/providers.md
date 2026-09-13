# Any brain you want: Claude, Gemini, and other providers

Code Director's guardrails do not care which model drives the agent — the
Vibe Check, the enforcement hook, and the Change Report work identically on
every provider. Kimi Code CLI connects to six provider types natively:
`kimi`, `anthropic`, `openai`, `openai_responses`, `google-genai`, and
`vertexai`. This guide covers the two you are most likely to add, plus the
generic case.

There are two routes. The interactive one is easier; the file one is
reviewable and shareable.

## Route 1 — interactive (60 seconds)

Inside a Kimi Code session:

```
/provider
```

Choose **Add New Platform**, pick the provider from the model catalog
(pulled live from models.dev), paste the API key, pick a default model.
Done — the CLI writes the config for you.

## Route 2 — config file (reviewable)

Edit `~/.kimi-code/config.toml`. Two blocks per brain: a **provider** (how
to connect) and a **model alias** (what to call it). Examples:

**Claude (Anthropic):**

```toml
[providers.anthropic]
type = "anthropic"
api_key = "sk-ant-xxxxx"

[models."claude-opus-4-7"]
provider = "anthropic"
model = "claude-opus-4-7"
max_context_size = 200000
```

**Gemini (Google):**

```toml
[providers.gemini]
type = "google-genai"
api_key = "xxxxx"

[models."gemini-3-flash"]
provider = "gemini"
model = "gemini-3-flash-preview"
max_context_size = 1048576
```

**Any OpenAI-compatible service** (DeepSeek, Qwen, local gateways — same
shape, override `base_url`):

```toml
[providers.deepseek]
type = "openai"
base_url = "https://api.deepseek.com/v1"
api_key = "sk-xxxxx"

[models."deepseek-chat"]
provider = "deepseek"
model = "deepseek-chat"
max_context_size = 131072
```

Capabilities (thinking, vision, tool use) are auto-detected from the model
name; you only declare `capabilities` by hand for unusual or proxied models.

## Switching brains

- Inside a session: `/model` — pick from everything configured.
- One-off headless run: `kimi -m "claude-opus-4-7" -p "your task"`.
- Change the default: `default_model = "claude-opus-4-7"` at the top of
  `config.toml`.

## Rules that will bite you if ignored

1. **Credentials live in the config file, not your shell.** The CLI does
   not read `export ANTHROPIC_API_KEY` from the environment — write the key
   into `config.toml` (the `api_key` field, or the provider's `env`
   sub-table). A missing key fails at startup, loudly.
2. **Quote dotted names.** TOML reads `.` as nesting:
   `[models."gpt-4.1"]`, never `[models.gpt-4.1]`.
3. **Restart (or `/reload`) after editing.** Providers load at startup.
4. **The guardrails are model-independent, but obedience is not.** The
   fence works on every provider; how willingly an engine drafts a Vibe
   Check before editing varies with the model's instruction-following.
   Weaker models may need the explicit `/codedirector:lock` command where
   stronger ones follow the skill on their own.

## References

- [Kimi Code — Providers and models](https://moonshotai.github.io/kimi-code/en/configuration/providers.html)
- [Kimi Code — Configuration files](https://moonshotai.github.io/kimi-code/en/configuration/config-files.html)
