#!/usr/bin/env bun
import { resolve, dirname } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

const MW_DIR = resolve(homedir(), ".meshwork");
const SESSIONS_FILE = resolve(MW_DIR, "sessions.json");
const BROKER_PORT = parseInt(process.env.MESHWORK_PORT || "7899");
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const BRIDGE_DIR = resolve(import.meta.dir, "bridge");

// --- Types ---

type Tier = "observer" | "worker" | "orchestrator";

interface Session {
  name: string;
  path: string;
  tier?: Tier;
  meshChannel?: string;
  acceptFrom?: string;
  yolo?: boolean;
  ask?: boolean;
  noRemoteControl?: boolean;
  channels?: string[];
  created_at: string;
}

// --- Helpers ---

function ensureMwDir() {
  if (!existsSync(MW_DIR)) mkdirSync(MW_DIR, { recursive: true });
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
  ensureMwDir();
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
  const tier = session.tier || "worker";
  const meshCh = session.meshChannel || "default";
  const acceptFrom = session.acceptFrom || "*";
  const parts = [`MW_NAME=${session.name}`, `MW_TIER=${tier}`, `MW_CHANNEL=${meshCh}`, `MW_ACCEPT_FROM=${acceptFrom}`, "claude"];

  if (session.yolo) {
    parts.push("--dangerously-skip-permissions");
  } else if (session.ask) {
    // Default interactive — no flag needed
  } else {
    parts.push("--enable-auto-mode");
  }

  const channelEntries = ["server:meshwork"];
  if (session.channels) {
    for (const ch of session.channels) channelEntries.push(ch);
  }
  parts.push("--dangerously-load-development-channels");
  parts.push(channelEntries.join(" "));

  parts.push("--name", `mw-${session.name}`);

  if (!session.noRemoteControl) {
    parts.push("/remote-control");
  }

  return parts.join(" ");
}

function buildResumCmd(session: Session): string {
  const tier = session.tier || "worker";
  const meshCh = session.meshChannel || "default";
  const acceptFrom = session.acceptFrom || "*";
  const parts = [`MW_NAME=${session.name}`, `MW_TIER=${tier}`, `MW_CHANNEL=${meshCh}`, `MW_ACCEPT_FROM=${acceptFrom}`, "claude"];

  if (session.yolo) {
    parts.push("--dangerously-skip-permissions");
  } else if (session.ask) {
    // no flag
  } else {
    parts.push("--enable-auto-mode");
  }

  const channelEntries = ["server:meshwork"];
  if (session.channels) {
    for (const ch of session.channels) channelEntries.push(ch);
  }
  parts.push("--dangerously-load-development-channels");
  parts.push(channelEntries.join(" "));

  parts.push("--resume", `mw-${session.name}`);

  if (!session.noRemoteControl) {
    parts.push("/remote-control");
  }

  return parts.join(" ");
}

async function tmuxSessionExists(name: string): Promise<boolean> {
  const r = await sh(["tmux", "has-session", "-t", `mw-${name}`]);
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
    `mw-${session.name}`,
    "-c",
    session.path,
    cmd,
  ]);
  if (!result.ok) return { ok: false, error: result.stderr };

  // Auto-confirm startup prompts (channels warning, hooks trust, etc.).
  for (let i = 1; i <= 3; i++) {
    setTimeout(async () => {
      await sh(["tmux", "send-keys", "-t", `mw-${session.name}`, "Enter"]);
    }, i * 2000);
  }

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
  ensureMwDir();
  if (!existsSync(SESSIONS_FILE)) {
    saveSessions([]);
    log("Created ~/.meshwork/sessions.json");
  }

  const claudeJsonPath = resolve(homedir(), ".claude.json");
  let config: any = {};
  if (existsSync(claudeJsonPath)) {
    try {
      config = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    } catch {}
  }

  const serverPath = resolve(BRIDGE_DIR, "server.ts");

  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers["meshwork"] = {
    command: "bun",
    args: [serverPath],
  };

  // Clean up old pcc-bridge entry if migrating
  if (config.mcpServers["pcc-bridge"]) delete config.mcpServers["pcc-bridge"];
  if (config["pcc-bridge"]) delete config["pcc-bridge"];

  writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + "\n");

  // Clean up old entry from settings.json
  const settingsPath = resolve(homedir(), ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      let dirty = false;
      if (settings.mcpServers?.["pcc-bridge"]) {
        delete settings.mcpServers["pcc-bridge"];
        dirty = true;
      }
      if (settings.mcpServers?.["meshwork"]) {
        delete settings.mcpServers["meshwork"];
        dirty = true;
      }
      if (dirty) {
        if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      }
    } catch {}
  }

  log(`Added meshwork MCP server to ${claudeJsonPath}`);
  log(`Bridge server: ${serverPath}`);
  log("\nMeshwork initialized. Run 'meshwork create <name> <path>' to create a session.");
}

async function cmdCreate(args: string[]) {
  const flags = parseFlags(args);
  const positional = flags._;
  if (positional.length < 2) {
    error("usage: meshwork create <name> <path> [--tier observer|worker|orchestrator] [--mesh-channel <ch>] [--accept-from <policy>] [--yolo] [--ask] [--no-remote-control] [--channel <ch>]");
  }

  const name = positional[0];
  const path = resolve(positional[1]);

  if (!existsSync(path)) {
    error(`path does not exist: ${path}`);
  }

  if (await tmuxSessionExists(name)) {
    error(`session "mw-${name}" already exists in tmux`);
  }

  const tier = (flags.tier && ["observer", "worker", "orchestrator"].includes(flags.tier))
    ? flags.tier as Tier
    : "worker";

  const session: Session = {
    name,
    path,
    tier,
    meshChannel: flags["mesh-channel"] || undefined,
    acceptFrom: flags["accept-from"] || undefined,
    yolo: flags.yolo || false,
    ask: flags.ask || false,
    noRemoteControl: flags["no-remote-control"] || false,
    channels: flags.channel ? (Array.isArray(flags.channel) ? flags.channel : [flags.channel]) : undefined,
    created_at: new Date().toISOString(),
  };

  const cmd = buildClaudeCmd(session);
  const result = await createTmuxSession(session, cmd);
  if (!result.ok) error(`failed to create tmux session: ${result.error}`);

  const sessions = loadSessions().filter((s) => s.name !== name);
  sessions.push(session);
  saveSessions(sessions);

  log(`Created session "${name}" in ${path}`);
  log(`tmux: mw-${name}`);
  log(`Command: ${cmd}`);

  if (flags.attach || flags.a) {
    log("Attaching to session... (Ctrl+b d to detach)");
    const attach = Bun.spawn(["tmux", "attach-session", "-t", `mw-${name}`], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    await attach.exited;
  }
}

async function cmdAdopt(args: string[]) {
  const flags = parseFlags(args);
  const positional = flags._;
  if (positional.length < 2) {
    error("usage: meshwork adopt <name> <path> [--session <id>] [--continue] [--tier observer|worker|orchestrator] [--mesh-channel <ch>] [--accept-from <policy>] [--yolo] [--channel <ch>]");
  }

  const name = positional[0];
  const path = resolve(positional[1]);

  if (await tmuxSessionExists(name)) {
    error(`session "mw-${name}" already exists in tmux`);
  }

  const tier = (flags.tier && ["observer", "worker", "orchestrator"].includes(flags.tier))
    ? flags.tier as Tier
    : "worker";
  const meshCh = flags["mesh-channel"] || "default";
  const acceptFrom = flags["accept-from"] || "*";

  const session: Session = {
    name,
    path,
    tier,
    meshChannel: flags["mesh-channel"] || undefined,
    acceptFrom: flags["accept-from"] || undefined,
    yolo: flags.yolo || false,
    ask: flags.ask || false,
    noRemoteControl: flags["no-remote-control"] || false,
    channels: flags.channel ? (Array.isArray(flags.channel) ? flags.channel : [flags.channel]) : undefined,
    created_at: new Date().toISOString(),
  };

  const parts = [`MW_NAME=${name}`, `MW_TIER=${tier}`, `MW_CHANNEL=${meshCh}`, `MW_ACCEPT_FROM=${acceptFrom}`, "claude"];

  if (session.yolo) parts.push("--dangerously-skip-permissions");
  else if (!session.ask) parts.push("--enable-auto-mode");

  const channelEntries = ["server:meshwork"];
  if (session.channels) for (const ch of session.channels) channelEntries.push(ch);
  parts.push("--dangerously-load-development-channels", channelEntries.join(" "));

  if (flags.session) {
    parts.push("--resume", flags.session);
  } else if (flags.continue) {
    parts.push("--continue");
  }

  parts.push("--name", `mw-${name}`);

  if (!session.noRemoteControl) parts.push("/remote-control");

  const cmd = parts.join(" ");
  const result = await createTmuxSession(session, cmd);
  if (!result.ok) error(`failed to create tmux session: ${result.error}`);

  if (flags.session || flags.continue) {
    setTimeout(async () => {
      await sh([
        "tmux",
        "send-keys",
        "-t",
        `mw-${name}`,
        `/rename mw-${name}`,
        "Enter",
      ]);
    }, 5000);
  }

  const sessions = loadSessions().filter((s) => s.name !== name);
  sessions.push(session);
  saveSessions(sessions);

  log(`Adopted session "${name}" in ${path}`);
  log(`tmux: mw-${name}`);
}

async function cmdList() {
  const sessions = loadSessions();

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
      if (sName?.startsWith("mw-")) {
        tmuxSessions.set(sName.replace(/^mw-/, ""), parseInt(activity));
      }
    }
  }

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
    log("No sessions registered. Run 'meshwork create <name> <path>' to create one.");
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
    flags.push(s.tier || "worker");
    if (s.meshChannel && s.meshChannel !== "default") flags.push(`#${s.meshChannel}`);
    if (s.yolo) flags.push("yolo");
    if (s.ask) flags.push("ask");
    if (s.channels?.length) flags.push(`+${s.channels.length} channels`);

    const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
    log(`• ${s.name} — ${s.path} — ${status}${flagStr}`);
  }
}

async function cmdStop(args: string[]) {
  const name = args[0];
  if (!name) error("usage: meshwork stop <name>");

  const result = await sh(["tmux", "kill-session", "-t", `mw-${name}`]);
  if (!result.ok) {
    error(`session "mw-${name}" not found or already stopped`);
  }
  log(`Stopped session "${name}". Still in registry — 'meshwork start ${name}' to bring it back.`);
}

async function cmdEdit(args: string[]) {
  const flags = parseFlags(args);
  const name = flags._[0];
  if (!name) error("usage: meshwork edit <name> [--tier <t>] [--mesh-channel <ch>] [--accept-from <policy>] [--yolo] [--no-yolo] [--ask] [--no-ask] [--channel <ch>] [--no-channels] [--no-remote-control] [--remote-control]");

  const sessions = loadSessions();
  const session = sessions.find((s) => s.name === name);
  if (!session) error(`session "${name}" not in registry`);

  let changed = false;

  if (flags.tier && ["observer", "worker", "orchestrator"].includes(flags.tier)) {
    session.tier = flags.tier as Tier;
    changed = true;
  }
  if (flags["mesh-channel"]) { session.meshChannel = flags["mesh-channel"]; changed = true; }
  if (flags["accept-from"]) { session.acceptFrom = flags["accept-from"]; changed = true; }
  if (flags.yolo) { session.yolo = true; session.ask = false; changed = true; }
  if (flags["no-yolo"]) { session.yolo = false; changed = true; }
  if (flags.ask) { session.ask = true; session.yolo = false; changed = true; }
  if (flags["no-ask"]) { session.ask = false; changed = true; }
  if (flags["remote-control"]) { session.noRemoteControl = false; changed = true; }
  if (flags["no-remote-control"]) { session.noRemoteControl = true; changed = true; }
  if (flags["no-channels"]) { session.channels = undefined; changed = true; }
  if (flags.channel) {
    const newChannels = Array.isArray(flags.channel) ? flags.channel : [flags.channel];
    session.channels = newChannels;
    changed = true;
  }

  if (!changed) {
    log(`Session "${name}":`);
    log(`  Path: ${session.path}`);
    log(`  Tier: ${session.tier || "worker"}`);
    log(`  Mesh channel: ${session.meshChannel || "default"}`);
    log(`  Accept from: ${session.acceptFrom || "*"}`);
    log(`  Permissions: ${session.yolo ? "yolo" : session.ask ? "ask" : "auto-mode"}`);
    log(`  Remote control: ${session.noRemoteControl ? "off" : "on"}`);
    log(`  Extra channels: ${session.channels?.join(", ") || "none"}`);
    log(`\nUse flags to modify: --tier, --mesh-channel, --accept-from, --yolo, --no-yolo, --ask, --channel <ch>, --no-channels, --remote-control, --no-remote-control`);
    return;
  }

  saveSessions(sessions);

  const running = await tmuxSessionExists(name);
  log(`Updated "${name}" config.`);
  log(`  Tier: ${session.tier || "worker"}`);
  log(`  Mesh channel: ${session.meshChannel || "default"}`);
  log(`  Accept from: ${session.acceptFrom || "*"}`);
  log(`  Permissions: ${session.yolo ? "yolo" : session.ask ? "ask" : "auto-mode"}`);
  log(`  Remote control: ${session.noRemoteControl ? "off" : "on"}`);
  log(`  Extra channels: ${session.channels?.join(", ") || "none"}`);
  if (running) {
    log(`\nSession is running — restart for changes to take effect:`);
    log(`  meshwork stop ${name} && meshwork start ${name}`);
  }
}

async function cmdStart(args: string[]) {
  const name = args[0];
  if (!name) error("usage: meshwork start <name>");

  const session = findSession(name);
  if (!session) error(`session "${name}" not in registry. Use 'meshwork create' instead.`);

  if (await tmuxSessionExists(name)) {
    error(`session "mw-${name}" is already running`);
  }

  const resumeCmd = buildResumCmd(session);
  const result = await createTmuxSession(session, resumeCmd);
  if (result.ok) {
    log(`Started "${name}" (resuming previous conversation)`);
  } else {
    const freshCmd = buildClaudeCmd(session);
    const freshResult = await createTmuxSession(session, freshCmd);
    if (freshResult.ok) {
      log(`Started "${name}" (fresh session)`);
    } else {
      error(`failed to start: ${freshResult.error}`);
    }
  }
}

async function cmdRemove(args: string[]) {
  const name = args[0];
  if (!name) error("usage: meshwork remove <name>");

  await sh(["tmux", "kill-session", "-t", `mw-${name}`]);

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

    const resumeCmd = buildResumCmd(session);
    const result = await createTmuxSession(session, resumeCmd);
    if (result.ok) {
      log(`• ${session.name} — restored (resuming previous conversation)`);
      restored++;
    } else {
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
  if (!name) error("usage: meshwork output <name> [--lines N]");

  const lines = flags.lines || 50;
  const result = await sh([
    "tmux",
    "capture-pane",
    "-t",
    `mw-${name}`,
    "-p",
    "-S",
    `-${lines}`,
  ]);
  if (!result.ok) error(`session "mw-${name}" not found`);
  console.log(result.stdout);
}

async function cmdSend(args: string[]) {
  const name = args[0];
  const message = args.slice(1).join(" ");
  if (!name || !message) error("usage: meshwork send <name> <message>");

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

async function cmdAttach(args: string[]) {
  const name = args[0];
  if (!name) error("usage: meshwork attach <name>");

  if (!(await tmuxSessionExists(name))) {
    error(`session "mw-${name}" is not running`);
  }

  const proc = Bun.spawn(
    ["tmux", "attach-session", "-t", `mw-${name}`],
    { stdio: ["inherit", "inherit", "inherit"] }
  );
  await proc.exited;
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
        log(`  • ${p.name} [${p.tier || "worker"}] — ${p.status || "no status"} — ${p.cwd}`);
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
    } else if (arg === "--attach" || arg === "-a") {
      result.attach = true;
    } else if (arg === "--no-yolo") {
      result["no-yolo"] = true;
    } else if (arg === "--no-ask") {
      result["no-ask"] = true;
    } else if (arg === "--no-channels") {
      result["no-channels"] = true;
    } else if (arg === "--remote-control") {
      result["remote-control"] = true;
    } else if (arg === "--continue") {
      result.continue = true;
    } else if (arg === "--tier" && i + 1 < args.length) {
      i++;
      result.tier = args[i];
    } else if (arg === "--mesh-channel" && i + 1 < args.length) {
      i++;
      result["mesh-channel"] = args[i];
    } else if (arg === "--accept-from" && i + 1 < args.length) {
      i++;
      result["accept-from"] = args[i];
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
  case "edit":
    await cmdEdit(args);
    break;
  case "list":
  case "ls":
    await cmdList();
    break;
  case "start":
    await cmdStart(args);
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
  case "attach":
    await cmdAttach(args);
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
    log(`meshwork — Agent session mesh

Usage:
  meshwork init                              Setup meshwork (install MCP server)
  meshwork create <name> <path> [flags]      Create a new session
  meshwork adopt <name> <path> [flags]       Adopt an existing session
  meshwork edit <name> [flags]               Edit session config (show if no flags)
  meshwork list                              List all sessions
  meshwork start <name>                      Start a stopped session
  meshwork stop <name>                       Stop a session (keeps in registry)
  meshwork remove <name>                     Stop and remove from registry
  meshwork restore                           Restore all sessions after reboot
  meshwork attach <name>                     Attach to a session (Ctrl+b d to detach)
  meshwork output <name> [--lines N]         Capture session terminal output
  meshwork send <name> <message>             Send a message via the broker
  meshwork status                            Show broker health and peers

  Also available as 'mw' (e.g., mw list, mw create, mw attach).

Flags for create/adopt:
  --tier <t>            Permission tier: observer, worker (default), orchestrator
  --mesh-channel <ch>   Mesh channel for message isolation (default: "default")
  --accept-from <p>     Who can message this session: * (default), orchestrator-only, or peer name
  --yolo                Use --dangerously-skip-permissions
  --ask                 Use interactive permissions (no auto-mode)
  --no-remote-control   Don't start in remote-control mode
  --attach, -a          Attach to session after creation
  --channel <ch>        Add extra Claude Code channel (repeatable)
  --session <id>        Resume specific session (adopt only)
  --continue            Resume most recent session (adopt only)

Tiers:
  observer              Can receive messages, see peers, and list tasks
  worker                Can send to orchestrators, update assigned tasks (default)
  orchestrator          Full access — message any peer, delegate tasks`);
    break;
}
