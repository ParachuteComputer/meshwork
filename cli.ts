#!/usr/bin/env bun
import { resolve, dirname } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

const PCC_DIR = resolve(homedir(), ".pcc");
const SESSIONS_FILE = resolve(PCC_DIR, "sessions.json");
const BROKER_PORT = parseInt(process.env.PCC_BROKER_PORT || "7899");
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const BRIDGE_DIR = resolve(import.meta.dir, "bridge");

// --- Types ---

interface Session {
  name: string;
  path: string;
  yolo?: boolean;
  ask?: boolean;
  noRemoteControl?: boolean;
  channels?: string[];
  created_at: string;
}

// --- Helpers ---

function ensurePccDir() {
  if (!existsSync(PCC_DIR)) mkdirSync(PCC_DIR, { recursive: true });
}

function loadSessions(): Session[] {
  if (!existsSync(SESSIONS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveSessions(sessions: Session[]) {
  ensurePccDir();
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2) + "\n");
}

function findSession(name: string): Session | undefined {
  return loadSessions().find((s) => s.name === name);
}

async function sh(
  cmd: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

function buildClaudeCmd(session: Session): string {
  const parts = ["PCC_NAME=" + session.name, "claude"];

  // Permission mode
  if (session.yolo) {
    parts.push("--dangerously-skip-permissions");
  } else if (session.ask) {
    // Default interactive — no flag needed
  } else {
    parts.push("--enable-auto-mode");
  }

  // Channels: always include pcc-bridge, plus any extras
  const channelEntries = ["server:pcc-bridge"];
  if (session.channels) {
    for (const ch of session.channels) channelEntries.push(ch);
  }
  parts.push("--dangerously-load-development-channels");
  parts.push(channelEntries.join(" "));

  // Session name for resume support
  parts.push("--name", `pcc-${session.name}`);

  // Remote control
  if (!session.noRemoteControl) {
    parts.push("/remote-control");
  }

  return parts.join(" ");
}

function buildResumCmd(session: Session): string {
  const parts = ["PCC_NAME=" + session.name, "claude"];

  if (session.yolo) {
    parts.push("--dangerously-skip-permissions");
  } else if (session.ask) {
    // no flag
  } else {
    parts.push("--enable-auto-mode");
  }

  const channelEntries = ["server:pcc-bridge"];
  if (session.channels) {
    for (const ch of session.channels) channelEntries.push(ch);
  }
  parts.push("--dangerously-load-development-channels");
  parts.push(channelEntries.join(" "));

  // Resume by name instead of starting fresh
  parts.push("--resume", `pcc-${session.name}`);

  if (!session.noRemoteControl) {
    parts.push("/remote-control");
  }

  return parts.join(" ");
}

async function tmuxSessionExists(name: string): Promise<boolean> {
  const r = await sh(["tmux", "has-session", "-t", `pcc-${name}`]);
  return r.ok;
}

async function createTmuxSession(
  session: Session,
  cmd: string
): Promise<{ ok: boolean; error?: string }> {
  const result = await sh([
    "tmux",
    "new-session",
    "-d",
    "-s",
    `pcc-${session.name}`,
    "-c",
    session.path,
    cmd,
  ]);
  if (!result.ok) return { ok: false, error: result.stderr };
  return { ok: true };
}

function log(msg: string) {
  console.log(msg);
}

function error(msg: string) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// --- Commands ---

async function cmdInit() {
  ensurePccDir();
  if (!existsSync(SESSIONS_FILE)) {
    saveSessions([]);
    log("Created ~/.pcc/sessions.json");
  }

  // Add MCP server to ~/.claude/settings.json
  const claudeSettingsPath = resolve(homedir(), ".claude", "settings.json");
  let settings: any = {};
  if (existsSync(claudeSettingsPath)) {
    try {
      settings = JSON.parse(readFileSync(claudeSettingsPath, "utf-8"));
    } catch {}
  }

  if (!settings.mcpServers) settings.mcpServers = {};

  const serverPath = resolve(BRIDGE_DIR, "server.ts");
  settings.mcpServers["pcc-bridge"] = {
    command: "bun",
    args: [serverPath],
  };

  const claudeDir = dirname(claudeSettingsPath);
  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
  writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2) + "\n");

  log(`Added pcc-bridge MCP server to ${claudeSettingsPath}`);
  log(`Bridge server: ${serverPath}`);
  log("\nPCC initialized. Run 'pcc create <name> <path>' to create a session.");
}

async function cmdCreate(args: string[]) {
  const flags = parseFlags(args);
  const positional = flags._;
  if (positional.length < 2) {
    error("usage: pcc create <name> <path> [--yolo] [--ask] [--no-remote-control] [--channel <ch>]");
  }

  const name = positional[0];
  const path = resolve(positional[1]);

  if (!existsSync(path)) {
    error(`path does not exist: ${path}`);
  }

  if (await tmuxSessionExists(name)) {
    error(`session "pcc-${name}" already exists in tmux`);
  }

  const session: Session = {
    name,
    path,
    yolo: flags.yolo || false,
    ask: flags.ask || false,
    noRemoteControl: flags["no-remote-control"] || false,
    channels: flags.channel ? (Array.isArray(flags.channel) ? flags.channel : [flags.channel]) : undefined,
    created_at: new Date().toISOString(),
  };

  const cmd = buildClaudeCmd(session);
  const result = await createTmuxSession(session, cmd);
  if (!result.ok) error(`failed to create tmux session: ${result.error}`);

  // Save to registry
  const sessions = loadSessions().filter((s) => s.name !== name);
  sessions.push(session);
  saveSessions(sessions);

  log(`Created session "${name}" in ${path}`);
  log(`tmux: pcc-${name}`);
  log(`Command: ${cmd}`);
}

async function cmdAdopt(args: string[]) {
  const flags = parseFlags(args);
  const positional = flags._;
  if (positional.length < 2) {
    error("usage: pcc adopt <name> <path> [--session <id>] [--continue] [--yolo] [--channel <ch>]");
  }

  const name = positional[0];
  const path = resolve(positional[1]);

  if (await tmuxSessionExists(name)) {
    error(`session "pcc-${name}" already exists in tmux`);
  }

  const session: Session = {
    name,
    path,
    yolo: flags.yolo || false,
    ask: flags.ask || false,
    noRemoteControl: flags["no-remote-control"] || false,
    channels: flags.channel ? (Array.isArray(flags.channel) ? flags.channel : [flags.channel]) : undefined,
    created_at: new Date().toISOString(),
  };

  // Build resume command
  const parts = ["PCC_NAME=" + name, "claude"];

  if (session.yolo) parts.push("--dangerously-skip-permissions");
  else if (!session.ask) parts.push("--enable-auto-mode");

  const channelEntries = ["server:pcc-bridge"];
  if (session.channels) for (const ch of session.channels) channelEntries.push(ch);
  parts.push("--dangerously-load-development-channels", channelEntries.join(" "));

  if (flags.session) {
    parts.push("--resume", flags.session);
  } else if (flags.continue) {
    parts.push("--continue");
  }

  // Rename to pcc convention after resuming
  parts.push("--name", `pcc-${name}`);

  if (!session.noRemoteControl) parts.push("/remote-control");

  const cmd = parts.join(" ");
  const result = await createTmuxSession(session, cmd);
  if (!result.ok) error(`failed to create tmux session: ${result.error}`);

  // Give Claude a moment to start, then ensure the session is renamed
  // --name may not rename an already-existing session, so inject /rename
  if (flags.session || flags.continue) {
    setTimeout(async () => {
      await sh([
        "tmux",
        "send-keys",
        "-t",
        `pcc-${name}`,
        `/rename pcc-${name}`,
        "Enter",
      ]);
    }, 5000);
  }

  const sessions = loadSessions().filter((s) => s.name !== name);
  sessions.push(session);
  saveSessions(sessions);

  log(`Adopted session "${name}" in ${path}`);
  log(`tmux: pcc-${name}`);
}

async function cmdList() {
  const sessions = loadSessions();

  // Get tmux status for each
  const tmuxResult = await sh([
    "tmux",
    "list-sessions",
    "-F",
    "#{session_name}\t#{session_activity}",
  ]);
  const tmuxSessions = new Map<string, number>();
  if (tmuxResult.ok) {
    for (const line of tmuxResult.stdout.split("\n")) {
      const [sName, activity] = line.split("\t");
      if (sName?.startsWith("pcc-")) {
        tmuxSessions.set(sName.replace(/^pcc-/, ""), parseInt(activity));
      }
    }
  }

  // Get bridge peers
  let peers: any[] = [];
  try {
    const res = await fetch(`${BROKER_URL}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      const peersRes = await fetch(`${BROKER_URL}/peers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exclude: "" }),
      });
      peers = await peersRes.json();
    }
  } catch {}

  if (sessions.length === 0) {
    log("No sessions registered. Run 'pcc create <name> <path>' to create one.");
    return;
  }

  for (const s of sessions) {
    const activity = tmuxSessions.get(s.name);
    const peer = peers.find((p: any) => p.name === s.name);

    let status = "";
    if (activity) {
      const ago = Math.round((Date.now() - activity * 1000) / 1000);
      status += `running (active ${ago}s ago)`;
    } else {
      status += "stopped";
    }

    if (peer?.status) {
      status += ` — "${peer.status}"`;
    } else if (peer) {
      status += " — on bridge";
    }

    const flags = [];
    if (s.yolo) flags.push("yolo");
    if (s.ask) flags.push("ask");
    if (s.channels?.length) flags.push(`+${s.channels.length} channels`);

    const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
    log(`• ${s.name} — ${s.path} — ${status}${flagStr}`);
  }
}

async function cmdStop(args: string[]) {
  const name = args[0];
  if (!name) error("usage: pcc stop <name>");

  const result = await sh(["tmux", "kill-session", "-t", `pcc-${name}`]);
  if (!result.ok) {
    error(`session "pcc-${name}" not found or already stopped`);
  }
  log(`Stopped session "${name}". Still in registry — 'pcc restore' will bring it back.`);
}

async function cmdRemove(args: string[]) {
  const name = args[0];
  if (!name) error("usage: pcc remove <name>");

  // Kill tmux if running
  await sh(["tmux", "kill-session", "-t", `pcc-${name}`]);

  // Remove from registry
  const sessions = loadSessions().filter((s) => s.name !== name);
  saveSessions(sessions);
  log(`Removed session "${name}" from registry.`);
}

async function cmdRestore() {
  const sessions = loadSessions();
  if (sessions.length === 0) {
    log("No sessions to restore.");
    return;
  }

  let restored = 0;
  let skipped = 0;
  for (const session of sessions) {
    if (await tmuxSessionExists(session.name)) {
      log(`• ${session.name} — already running, skipping`);
      skipped++;
      continue;
    }

    // Try resume first, fall back to fresh
    const resumeCmd = buildResumCmd(session);
    const result = await createTmuxSession(session, resumeCmd);
    if (result.ok) {
      log(`• ${session.name} — restored (resuming previous conversation)`);
      restored++;
    } else {
      // Fall back to fresh session
      const freshCmd = buildClaudeCmd(session);
      const freshResult = await createTmuxSession(session, freshCmd);
      if (freshResult.ok) {
        log(`• ${session.name} — restored (fresh session)`);
        restored++;
      } else {
        log(`• ${session.name} — FAILED: ${freshResult.error}`);
      }
    }
  }
  log(`\nRestored ${restored}, skipped ${skipped} (already running).`);
}

async function cmdOutput(args: string[]) {
  const flags = parseFlags(args);
  const name = flags._[0];
  if (!name) error("usage: pcc output <name> [--lines N]");

  const lines = flags.lines || 50;
  const result = await sh([
    "tmux",
    "capture-pane",
    "-t",
    `pcc-${name}`,
    "-p",
    "-S",
    `-${lines}`,
  ]);
  if (!result.ok) error(`session "pcc-${name}" not found`);
  console.log(result.stdout);
}

async function cmdSend(args: string[]) {
  const name = args[0];
  const message = args.slice(1).join(" ");
  if (!name || !message) error("usage: pcc send <name> <message>");

  try {
    const res = await fetch(`${BROKER_URL}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_id: "cli", to: name, content: message }),
    });
    const data = await res.json();
    if (data.error) error(data.error);
    log(`Message sent to ${data.to_name}`);
  } catch {
    error("broker not running. Start a session first or run the broker manually.");
  }
}

async function cmdStatus() {
  try {
    const res = await fetch(`${BROKER_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const data = await res.json();
    log(`Broker: running on port ${BROKER_PORT}`);
    log(`Peers: ${data.peers}`);

    if (data.peers > 0) {
      const peersRes = await fetch(`${BROKER_URL}/peers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exclude: "" }),
      });
      const peers = await peersRes.json();
      for (const p of peers) {
        log(`  • ${p.name} — ${p.status || "no status"} — ${p.cwd}`);
      }
    }
  } catch {
    log("Broker: not running");
  }
}

// --- Flag parsing ---

function parseFlags(args: string[]): any {
  const result: any = { _: [] };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--yolo") {
      result.yolo = true;
    } else if (arg === "--ask") {
      result.ask = true;
    } else if (arg === "--no-remote-control") {
      result["no-remote-control"] = true;
    } else if (arg === "--continue") {
      result.continue = true;
    } else if (arg === "--channel" && i + 1 < args.length) {
      i++;
      if (!result.channel) result.channel = [];
      if (!Array.isArray(result.channel)) result.channel = [result.channel];
      result.channel.push(args[i]);
    } else if (arg === "--session" && i + 1 < args.length) {
      i++;
      result.session = args[i];
    } else if (arg === "--lines" && i + 1 < args.length) {
      i++;
      result.lines = parseInt(args[i]);
    } else if (!arg.startsWith("-")) {
      result._.push(arg);
    }
    i++;
  }
  return result;
}

// --- Main ---

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "init":
    await cmdInit();
    break;
  case "create":
    await cmdCreate(args);
    break;
  case "adopt":
    await cmdAdopt(args);
    break;
  case "list":
  case "ls":
    await cmdList();
    break;
  case "stop":
    await cmdStop(args);
    break;
  case "remove":
  case "rm":
    await cmdRemove(args);
    break;
  case "restore":
    await cmdRestore();
    break;
  case "output":
  case "log":
    await cmdOutput(args);
    break;
  case "send":
    await cmdSend(args);
    break;
  case "status":
    await cmdStatus();
    break;
  default:
    log(`pcc — Parachute Claude Control

Usage:
  pcc init                              Setup PCC (install MCP server)
  pcc create <name> <path> [flags]      Create a new Claude session
  pcc adopt <name> <path> [flags]       Adopt an existing Claude session
  pcc list                              List all sessions
  pcc stop <name>                       Stop a session (keeps in registry)
  pcc remove <name>                     Stop and remove from registry
  pcc restore                           Restore all sessions after reboot
  pcc output <name> [--lines N]         Capture session terminal output
  pcc send <name> <message>             Send a message via the broker
  pcc status                            Show broker health and peers

Flags for create/adopt:
  --yolo                Use --dangerously-skip-permissions
  --ask                 Use interactive permissions (no auto-mode)
  --no-remote-control   Don't start in remote-control mode
  --channel <ch>        Add extra channel (repeatable)
  --session <id>        Resume specific session (adopt only)
  --continue            Resume most recent session (adopt only)`);
    break;
}
