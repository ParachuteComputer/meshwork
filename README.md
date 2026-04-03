# Meshwork

A lightweight bridge that lets AI coding sessions discover each other and communicate in real-time using [MCP channels](https://code.claude.com/docs/en/channels.md).

Meshwork has two parts:
- **A CLI** (`meshwork` / `mw`) for managing sessions — create, stop, restore after reboot, and more
- **An MCP server** that gives every session 5 communication tools, with messages delivered instantly via channel push

## How it works

```
You (tablet / Telegram / claude.ai)
  │
  ▼
Orchestrator session ──bridge msg──▶ Worker sessions
  (meshwork + telegram)              (meshwork)
  ◀──bridge msg──────────────────────┘
```

Every session runs the meshwork MCP server as a subprocess. A shared SQLite broker on localhost routes messages between them. Messages arrive in the session's context as `<channel>` tags — like a coworker tapping it on the shoulder — so the agent reacts immediately without polling.

## Install

```bash
bun install -g github:ParachuteComputer/meshwork
```

## Setup

```bash
meshwork init
```

This adds the meshwork MCP server to `~/.claude.json` so every Claude Code session gets it automatically.

## Usage

### Create sessions

```bash
# Worker session (auto-mode permissions, remote-control enabled)
meshwork create atlas ~/Code/atlas

# Orchestrator with yolo + Telegram
meshwork create orchestrator ~/Code --yolo --channel "plugins:telegram@claude-plugins-official"

# Session with normal interactive permissions
meshwork create careful-worker ~/Code/sensitive --ask

# Attach to handle first-run prompts
meshwork create atlas ~/Code/atlas --attach
```

### Manage sessions

```bash
meshwork list                    # Show all sessions with status
meshwork start atlas             # Start a stopped session (resumes conversation)
meshwork stop atlas              # Stop (keeps in registry)
meshwork attach atlas            # Drop into a session (Ctrl+b d to detach)
meshwork edit atlas --yolo       # Change session config
meshwork remove atlas            # Stop and remove from registry
meshwork output atlas            # Capture terminal output
meshwork status                  # Broker health and connected peers
```

### After a reboot

```bash
meshwork restore
```

Recreates all registered sessions and resumes their previous conversations.

### Adopt existing sessions

```bash
meshwork adopt atlas ~/Code/atlas --continue       # Most recent session in that dir
meshwork adopt atlas ~/Code/atlas --session <id>   # Specific session ID
```

### Send messages from the terminal

```bash
meshwork send atlas "check for open PRs and summarize them"
```

### Short alias

All commands also work with `mw`:

```bash
mw create atlas ~/Code/atlas
mw list
mw send atlas "check PRs"
mw attach atlas
```

## How sessions communicate

Every session gets 5 MCP tools:

| Tool | Description |
|------|-------------|
| `list_peers` | See all connected sessions with their status |
| `send_peer_message` | Send a message to a peer by name |
| `check_messages` | Manual message check (fallback) |
| `set_my_status` | Announce what you're working on |
| `whoami` | Your identity on the bridge |

Messages are delivered via MCP channel push — the MCP server polls a local SQLite broker every second and pushes new messages into the session's context as `<channel>` notifications. The agent sees them and responds immediately.

### Example flow

The orchestrator asks atlas to review a PR:

```
Orchestrator calls: send_peer_message(to: "atlas", message: "Review PR #42")
         │
         ▼
    SQLite broker (localhost:7899)
         │
         ▼ (within 1 second)
    Atlas's MCP server polls, pushes via channel
         │
         ▼
    Atlas sees: <channel source="meshwork" from="orchestrator">
                Review PR #42
                </channel>
         │
         ▼
    Atlas does the review, calls: send_peer_message(to: "orchestrator", message: "Found 2 issues...")
```

## Architecture

```
~/.meshwork/sessions.json     Session registry (survives reboots)
~/.meshwork.db                SQLite broker database
~/.claude.json                MCP server registration

cli.ts                        CLI (meshwork / mw command)
bridge/
  broker.ts                   SQLite HTTP broker (auto-launched)
  server.ts                   MCP server (one per session)
  types.ts                    Shared types
```

**The broker** is a single-process HTTP server on localhost:7899 backed by SQLite. It's auto-launched by the first MCP server that starts — no manual setup needed.

**Message delivery** uses ACK-based delivery: messages aren't marked as delivered until the MCP server confirms the channel push succeeded. If the MCP server crashes between poll and ACK, messages are retried on next startup.

**Session persistence** uses Claude Code's `--name` flag. Each session is named `mw-{name}`, so `meshwork restore` can resume conversations by name after a reboot.

## Defaults

| Setting | Default | Override |
|---------|---------|----------|
| Permissions | `--enable-auto-mode` (safe classifier) | `--yolo` for skip-permissions, `--ask` for interactive |
| Remote control | On (`/remote-control`) | `--no-remote-control` |
| Bridge channel | Always enabled | — |
| Extra channels | None | `--channel <ch>` (repeatable) |

## Requirements

- [Bun](https://bun.sh) runtime
- [tmux](https://github.com/tmux/tmux) (sessions run in tmux)
- Claude Code with channels support (v2.1.80+)

## License

MIT
