# Agent Hub

A self-hosted web UI for terminal AI agents (Claude Code, Codex, Antigravity and other CLIs) on a Windows 11 computer. At the computer you work with the agents in the browser; when you leave, you turn on remote access and continue the same sessions from your phone. There is no login at the computer; the phone signs in only with a passkey and biometrics.

> **Do not use `tailscale funnel`.** Funnel publishes the service to the internet. The app gives access to running commands on the computer and is meant to be used only inside a tailnet.

## How it works

- The server (Node.js, Fastify) listens on two ports, both on `127.0.0.1` only:
  - `8780`: the UI at the computer, `http://localhost:8780`. Always available, no login, unreachable from outside.
  - `8781`: remote access. `tailscale serve` gives it HTTPS inside the tailnet. The Remote access switch decides whether this port answers; agents keep running when it is toggled.
- Whether a request is local or remote is decided by the port it came in on, not by headers. Sessions and passkeys exist only for remote access.
- Agents are described in `agents.json` and run under the owner's account with a cleaned environment, in a folder inside `allowedRoots`. Claude Code, Codex and Antigravity work as a chat: the server talks to them over their machine protocol, and every permission request arrives as an "Allow / Deny" card. The chat supports the agent's commands (`/` opens the list), shows images the agent read or wrote, and two agents can be linked so they talk to each other. Any other CLI runs in a terminal (ConPTY). Auto-approve flags are forbidden; in Settings a specific chat agent can be allowed to act without approvals (from the phone only with a passkey; the kill switch takes it back). The Usage page shows each account's plan limits, and the model and context fill are shown under the message box. Past sessions can be resumed with the button on a stopped agent or with the `/resume` command. Nothing but the described agents can be started from the UI.
- At the computer everything is available right away. On the phone, view mode is on after sign-in; input needs a fresh passkey check (step-up, 5 minutes).
- On the phone, dangerous actions (stop, restart, passkey changes) need a passkey check right before the action. Remote access can be turned on, and a phone connected, only at the computer.
- The UI is in English; Russian can be picked in Settings and is remembered on the device.
- More: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Setup

Step by step: [docs/SETUP_WINDOWS.md](docs/SETUP_WINDOWS.md). In short:

1. `npm ci`, `npm run build`, copy `config.example.json`, `agents.example.json` and `.env.example` without `.example`.
2. Set `allowedRoots` in `config.json` and the agent paths in `agents.json`.
3. `npm start`, open `http://localhost:8780`.
4. For the phone: Tailscale with MagicDNS and HTTPS, `tailscale serve --bg 8781`, `origin` in `config.json`, then turn on Remote access and press Phone → "Get a code" in the UI.
5. Start at Windows sign-in with Task Scheduler.

## Commands

| Command                                | What it does                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm start`                            | Starts the server.                                                                               |
| `npm run build`                        | Builds the frontend into `web/dist`.                                                             |
| `npm run remote -- on\|off\|status`    | Turns remote access on or off, or shows its state. Works while the server runs too.              |
| `npm run reset-auth`                   | Deletes all phone passkeys and sessions, turns remote access off.                                |
| `npm run killswitch`                   | Kills all agents, revokes all sessions, turns remote access off. Works even if the server hangs. |
| `npm test`                             | Tests (vitest).                                                                                  |
| `npm run lint`, `npm run format:check` | ESLint and Prettier.                                                                             |

## Configuration

`config.json`:

| Field                              | Default               | Description                                                                                    |
| ---------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `allowedRoots`                     | required              | Folders the agents may work in (the folder itself and its first-level subfolders are offered). |
| `origin`                           | none                  | `https://<name>.<tailnet>.ts.net`. Without it there is no remote access.                       |
| `port`, `remotePort`               | 8780, 8781            | The local port and the port for `tailscale serve`, both on `127.0.0.1`.                        |
| `stepupMinutes`                    | 5                     | How long control mode lasts on the phone, at most 5.                                           |
| `sessionHours`, `idleMinutes`      | 12, 30                | Absolute and idle session lifetime; they cannot be raised.                                     |
| `bufferBytes`                      | 2 MB                  | Output buffer per agent, for reconnecting.                                                     |
| `prompt.idleMs`, `prompt.patterns` | 1500, see the example | The "agent is waiting for approval" heuristic.                                                 |
| `agentEnv`                         | system variables      | Allowlist of environment variables for agents.                                                 |
| `logInputText`                     | false                 | Whether input text goes into the audit log (with secrets masked).                              |
| `ntfy`                             | none                  | `{ "url": "https://ntfy.sh", "topic": "..." }`. The token goes in `.env` (`NTFY_TOKEN`).       |
| `tailscaleUser`                    | none                  | If set, remote requests must carry this `Tailscale-User-Login`.                                |

`agents.json`: an array of `{ id, name, type, command, args, model, cwd, env }`.

- `type`: `terminal` (default), `claude`, `codex` or `antigravity`. For chat agents the server sets the launch flags, so `args` must be empty; the model can be picked with `model` (for example `"haiku"` for Claude or `"gemini-3.8-flash-low"` for Antigravity; `agy models` lists them).
- Several Claude Code accounts: add an agent for each, with the same `claude.exe` and its own config folder in `env`, the way the `claude-a.bat` wrappers do:

  ```json
  {
    "id": "claude-a",
    "name": "Claude Code A",
    "type": "claude",
    "command": "C:\\Users\\you\\.local\\bin\\claude.exe",
    "cwd": "C:\\Users\\you\\Documents\\GitHub",
    "env": { "CLAUDE_CONFIG_DIR": "C:\\Users\\you\\.claude-a" }
  }
  ```

  The `.bat` files themselves cannot be used as `command`: they are run by `cmd.exe`, which parses arguments its own way.

- `mcp: false` starts a Claude agent without the MCP servers from your Claude settings. Otherwise each agent starts its own copy of every server (for `npx` servers that is two node processes each).
- `command` is an absolute path only, without the characters `" % & | < > ^ !`. `cwd` (the default folder) is inside `allowedRoots`; `env` adds variables.
- Arguments that turn on auto-approval or bypass the sandbox are refused at load time.
