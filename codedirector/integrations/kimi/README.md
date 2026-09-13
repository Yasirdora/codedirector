# Code Director + Kimi Code CLI

The fastest setup is the **plugin**: one command installs the skill (the
rulebook), the MCP server (the tools), the enforcement hook (the fence),
and slash commands. The manual route underneath is documented after it,
for anyone who wants the pieces separately.

## Plugin install (recommended)

Prerequisite: the `cdir` CLI installed and on your PATH (see the package
README — `npm install && npm run build && npm link` from this repo, or
your published install).

Then, inside Kimi Code:

```
/plugins install https://github.com/Yasirdora/codedirector
/reload
```

That single install gives you:

- **the skill** — auto-loaded at every session start, so the agent drafts
  a Vibe Check and waits for approval before editing;
- **the MCP server** — the eight tools (`repo_map`, `blast_radius`,
  `lock_draft`, `lock_check`, `lock_activate`, `run_locked`, `report`,
  `undo`);
- **the PreToolUse hook** — edit-tool calls are checked against the active
  Lock: deny-listed and out-of-budget files are blocked with the reason
  written back to the agent, and edits with no active Lock get a reminder.
  The hook fails open on any error, and it cannot see inside shell
  commands — the after-the-fact verification in `cdir run` remains the
  hard floor;
- **slash commands** — `/codedirector:lock <request>` and
  `/codedirector:report`.

Manage it any time with `/plugins` (enable, disable, remove). Hooks and
MCP servers can be toggled individually there too.

## Manual setup (the pieces, one by one)

Kimi Code CLI has native support for both of Code Director's hooks: MCP
servers (the tools) and SKILL.md skills (the rulebook). Setup takes about
five minutes.

### 1. Install and log in

```sh
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
kimi --version
```

Then start `kimi` once and run `/login` — sign in with your Kimi account
(device-code flow) or a Moonshot API key.

## 2. Register the MCP server

There is no `kimi mcp add` shell command in current versions — MCP servers
are configured either conversationally inside the app or by editing one
JSON file. The file route is deterministic:

Edit `~/.kimi-code/mcp.json` (create it if it doesn't exist):

```json
{
  "mcpServers": {
    "codedirector": {
      "command": "cdir",
      "args": ["mcp"]
    }
  }
}
```

If `cdir` is not on the PATH that `kimi` inherits (for example it was
installed under a version manager), use the absolute path to the `cdir`
binary as `command` instead.

The in-app alternative: start `kimi`, run `/mcp-config`, and tell it in
plain language to add a stdio server named `codedirector` that runs
`cdir mcp`. Either way, `/mcp` inside a session lists the server and its
connection status. Restart `kimi` after editing `mcp.json` — servers load
at session start.

## 3. Install the skill

Kimi Code reads SKILL.md skills from `~/.kimi-code/skills/` (user level,
every project) or `.kimi-code/skills/` (one project). Copy the Code
Director skill to the user level:

```sh
mkdir -p ~/.kimi-code/skills
cp -r <path-to-this-repo>/skills/codedirector ~/.kimi-code/skills/
```

Start a new session (or `/reload`) so it gets picked up.

## 4. Prove it works — the before/after test

In a scratch project (`mkdir ~/cdir-test && cd ~/cdir-test && git init`):

1. Start `kimi`, run `/mcp` — `codedirector` should show its eight tools
   (`repo_map`, `blast_radius`, `lock_draft`, `lock_check`, `lock_activate`,
   `run_locked`, `report`, `undo`).
2. Ask for something vague — "create something better than AnkiMobile".
3. **Pass:** it drafts a Vibe Check — goal, files in budget, denied
   zones — and waits for your approval before touching anything.
   **Fail:** it starts building immediately. Re-check `/mcp` and that the
   skill copied to the right path.
4. Afterwards, `cdir report IL-0001` in another terminal gives you the
   receipt.

## Notes

- Kimi Code also reads `AGENTS.md` as standing instructions (user level:
  `~/.kimi-code/AGENTS.md`, project level: the repo root). The SKILL.md in
  step 3 is usually enough; add an AGENTS.md pointer only if you want the
  workflow enforced even in projects where the skill isn't installed.
- Headless runs (`kimi -p "task"`) load the user-level `mcp.json`, so the
  guardrails work in scripted mode too.
- Want a different brain? Kimi Code connects natively to Claude, Gemini,
  and any OpenAI-compatible provider — see [providers.md](providers.md).
  The guardrails work identically on every one.

## Brand theme

The Code Director palette (brand yellow `#FED30B` on the dark base) ships
at [../../brand/codedirector.json](../../brand/codedirector.json). Install:

```sh
mkdir -p ~/.kimi-code/themes
cp <path-to-this-repo>/codedirector/brand/codedirector.json ~/.kimi-code/themes/
```

Then run `/theme` and pick **Custom: codedirector** — the picker rescans
the directory each time it opens, no restart needed.
