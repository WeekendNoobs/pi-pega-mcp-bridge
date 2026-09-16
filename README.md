# pi-pega-mcp-bridge

Run Pega Infinity authoring inside the [pi coding agent](https://github.com/badlogic/pi-mono). This extension spawns Pega's own MCP server (`infinity-rules-mcp.jar` from [pegasystems/infinity-ai-plugins](https://github.com/pegasystems/infinity-ai-plugins)) and registers its tools in pi as native tools. In a read-only session you get 22 tools: search and read rules, list case types, browse Pega's authoring skills, run data pages and PegaUnit tests. Enable write mode and you also get rule and case authoring through Pega's ChangeRequest workflow.

No MCP client plugin is installed into pi. The bridge spawns Pega's own server as a subprocess and speaks JSON-RPC over stdio, so the tools appear to the model exactly like built-in pi tools.

**Not affiliated with or endorsed by Pegasystems Inc.** This package ships no Pega code or binaries; it launches the server from Pega's own repository, which you clone separately.

## How it works

```
pi session
  └── extensions/pega-mcp.ts          (this bridge)
        └── spawns: java -jar infinity-rules-mcp.jar --spring.profiles.active=stdio
              └── tools/list  →  registered as native pi tools (once per pi process)
              └── tools/call  →  forwarded per tool call
              └── OAuth: browser-based login, loopback callback on localhost:8888
              └── talks to your Pega Infinity environment REST APIs
```

## Prerequisites

| Requirement | Notes |
|---|---|
| pi coding agent | https://github.com/badlogic/pi-mono |
| Java 17 or later | The Pega server is a Spring Boot jar and will not run on Java 11. |
| Pega Infinity 26.1+ | 25.1.3+ and 24.2.5+ require engagement with Pega Support |
| Pega environment access | You need an account that can author in the target application |
| Pega repo clone | `git clone https://github.com/pegasystems/infinity-ai-plugins.git` |

### Install Java

macOS:

```bash
brew install openjdk@17
```

Linux (Debian/Ubuntu):

```bash
sudo apt install openjdk-17-jre
```

Linux (RHEL/Fedora): `sudo dnf install java-17-openjdk`

Windows:

```powershell
winget install EclipseAdoptium.Temurin.17.JRE
```

Verify with `java -version`.

### Clone the Pega repo

The bridge looks for the jar at `~/.pi/agent/pega/infinity-ai-plugins/plugins/pega/infinity-ai-plugins/claude/resources/infinity-rules-mcp.jar` (Windows: `%USERPROFILE%\.pi\agent\pega\...`, resolved automatically). Use a different location by setting `PEGA_PLUGIN_DIR` to the `plugins/pega/infinity-ai-plugins/claude` directory.

```bash
mkdir -p ~/.pi/agent/pega
git clone https://github.com/pegasystems/infinity-ai-plugins.git ~/.pi/agent/pega/infinity-ai-plugins
```

You do **not** need to install the Pega plugin into Claude Code, Codex, or Copilot CLI. The clone is all this bridge uses.

## Pega-side setup (one time per environment)

1. In Pega, create an **OAuth 2.0 client registration** (Records → Integration → Services):
   - Client credentials type: **Public** (no secret)
   - Grant type: **Authorization code**
   - Redirect URI: `http://localhost:8888/callback` (exact scheme, port, and path)
2. Note the generated **client ID**.
3. The bridge connects as *your* Pega user. Everything it does happens with your permissions, so scope the client registration's access group accordingly.

## Install

```bash
pi install git:github.com/YOUR_GITHUB_USERNAME/pi-pega-mcp-bridge
```

Or, to try it without installing:

```bash
pi -e git:github.com/YOUR_GITHUB_USERNAME/pi-pega-mcp-bridge
```

## Configure the connection

Create `~/.infinity-rules-mcp/config.json` (`%USERPROFILE%\.infinity-rules-mcp\config.json` on Windows). This is the same file Pega's official plugins use:

```json
{
  "pega_base_url": "https://your-environment.example.com",
  "pega_oauth_client_id": "<your-client-id>",
  "pega_infinity_version": "26-1"
}
```

- `pega_base_url`: environment root only. No `/prweb`, no path segments.
- `pega_infinity_version`: one of `24-2`, `25-1`, `26-1`. Defaults to `26-1`.

**Restrict the file on macOS/Linux:** `chmod 600 ~/.infinity-rules-mcp/config.json`. The bridge warns at session start if the mode differs. The file is plaintext and gates access to your Pega environment; never commit it.

Start a new pi session. The first Pega tool call opens a browser for OAuth login. The session token is persisted, so you log in once, not per call.

## Read-only by default

The bridge registers **22 read tools** by default. Seven data-mutating tools are withheld unless you explicitly enable them:

`create-case`, `perform-action`, `trigger-optional-process`, `initiate-authoring-change`, `copy-rule`, `create-rule`, `update-rule`

To enable write access for a session:

```bash
PEGA_MCP_WRITE_TOOLS=1 pi
```

Writes go through Pega's ChangeRequest workflow (branch rulesets), which is Pega's own recommended authoring pattern. Ask the agent for `get-skill("recipes/change-request-workflow")` before your first write session.

## Commands

- `/pega-status`: server state, mode, registered tool count, config summary, last error
- `/pega-restart`: restart the jar, picks up `config.json` changes and Pega repo updates

## Configuration reference

### `~/.infinity-rules-mcp/config.json` (Pega's format)

| Key | Purpose |
|---|---|
| `pega_base_url` | Your environment root URL |
| `pega_oauth_client_id` | Client ID from the OAuth client registration |
| `pega_infinity_version` | Bundled skills payload version: `24-2`, `25-1`, `26-1` |

### Bridge environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PEGA_MCP_WRITE_TOOLS` | unset (read-only) | `1` enables the seven write tools |
| `PEGA_MCP_TIMEOUT_MS` | `120000` | Per-request timeout. Raise it for long PegaUnit runs. |
| `PEGA_MCP_EXPECTED_JAR_SHA256` | pinned hash | Override the jar integrity pin |
| `PEGA_PLUGIN_DIR` | `~/.pi/agent/pega/...` | Alternate location of the cloned repo's `claude` directory |

## Security model

- **Read-only default.** Write tools are opt-in per session (see above).
- **Jar integrity pin.** The bridge embeds the SHA-256 of the tested `infinity-rules-mcp.jar`. A mismatch (for example after `git pull` in the Pega repo) refuses to start and prints the actual hash. Update the pin deliberately via `PEGA_MCP_EXPECTED_JAR_SHA256` or by updating this package; never let a repo pull silently swap the executable.
- **Loopback OAuth.** Pega's server implements the authorization code flow over `http://localhost:8888/callback` with no PKCE. On a single-user machine this is standard practice; on shared hosts any local process could race the callback port. If port 8888 is occupied, set `PEGA_OAUTH_REDIRECT_PORT` in the environment and register the matching redirect URI in Pega. Both sides must change together.
- **Operator scope.** Tool calls execute as your Pega user through the client registration you created. Treat agent-initiated writes like any other change made by your account.
- **Server logs.** The jar writes logs into the clone under `plugins/pega/infinity-ai-plugins/claude/resources/logs/`. They can contain API traffic and case data. Do not commit or share that directory.
- **Pega license boundary.** This repository contains no Pegasystems code, binaries, or content. The jar and its skills payload are cloned from Pega's repository and remain governed by the "Pega Infinity AI Plugins License" shipped there, which permits use solely in connection with Pegasystems software. See LICENSE in this repo for the third-party notice.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `pega-mcp: server failed to start` with `UnsupportedClassVersionError` | Java older than 17. Install 17+ and run `/pega-restart`. |
| `pega-mcp: server failed to start` mentioning ENOENT / cannot find java | Java not on PATH. Install it, then restart pi or run `/pega-restart`. |
| `jar not found` | Pega repo not cloned to `~/.pi/agent/pega/`, or set `PEGA_PLUGIN_DIR`. |
| Hash mismatch at startup | The Pega repo changed the jar (usually after `git pull`). Verify the source, then set `PEGA_MCP_EXPECTED_JAR_SHA256` to the printed actual hash. |
| Browser login loops or times out | Check `pega_base_url` has no `/prweb` suffix, the OAuth client exists with redirect URI `http://localhost:8888/callback`, and nothing else occupies port 8888 during login. |
| Tools registered but every call fails | Run `/pega-status` for the last error, or `node scripts/verify.mjs` to test the connection outside pi. |
| `pega-status` shows fewer than 22 tools | Write tools are withheld in read-only mode. That is expected. |

Platform note: developed and tested on macOS (Apple Silicon). Linux and Windows use standard Node.js APIs and are expected to work. If something breaks on your platform, include your OS, Java vendor and version, and the full `/pega-status` output in the issue.

## Updating

- This bridge: `pi update --extensions`
- Pega's server: `git pull` in the clone at `~/.pi/agent/pega/infinity-ai-plugins`, then `/pega-restart`. If the jar hash changed, the bridge will refuse to start until you update the pin (see Security model). This is intentional.

## Verify the connection outside pi

```bash
node scripts/verify.mjs
```

Spawns the jar directly, performs the MCP handshake, and calls `list-available-applications`. Useful to separate bridge problems from Pega environment problems.

## License

MIT for this package's code. See LICENSE for details and the third-party notice regarding Pega components.
