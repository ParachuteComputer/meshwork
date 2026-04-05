import { Database } from "bun:sqlite";
import { resolve } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
import type { Peer, PeerRegistration, Message, Task, TaskState, Tier } from "./types.ts";

const PORT = parseInt(process.env.MESHWORK_PORT || "7899");
const DB_PATH =
  process.env.MESHWORK_DB || resolve(homedir(), ".meshwork.db");
const STALE_MS = 60_000;

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");
db.run("PRAGMA foreign_keys = ON");

db.run(`CREATE TABLE IF NOT EXISTS peers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL,
  pid INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT 'worker',
  channel TEXT NOT NULL DEFAULT 'default',
  accept_from TEXT NOT NULL DEFAULT '*',
  registered_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
)`);

db.run(`CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'default',
  description TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'submitted',
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);

// Migrate existing tables that lack new columns
for (const [col, def] of [
  ["token", "TEXT NOT NULL DEFAULT ''"],
  ["tier", "TEXT NOT NULL DEFAULT 'worker'"],
  ["channel", "TEXT NOT NULL DEFAULT 'default'"],
  ["accept_from", "TEXT NOT NULL DEFAULT '*'"],
] as const) {
  try { db.run(`ALTER TABLE peers ADD COLUMN ${col} ${def}`); } catch {}
}

function genToken(): string {
  return randomBytes(32).toString("hex");
}

// Validate token for authenticated endpoints. Returns the peer or null.
function authenticate(body: { id?: string; token?: string }): Peer | null {
  if (!body.id || !body.token) return null;
  const peer = db
    .query("SELECT * FROM peers WHERE id = ? AND token = ?")
    .get(body.id, body.token) as Peer | null;
  return peer;
}

const TIER_RANK: Record<Tier, number> = {
  observer: 0,
  worker: 1,
  orchestrator: 2,
};

const VALID_TASK_STATES = new Set<TaskState>([
  "submitted", "accepted", "working", "input-required", "completed", "failed", "cancelled",
]);

// Valid state transitions: from → allowed next states
const TASK_TRANSITIONS: Record<string, Set<string>> = {
  submitted: new Set(["accepted", "cancelled"]),
  accepted: new Set(["working", "cancelled"]),
  working: new Set(["input-required", "completed", "failed", "cancelled"]),
  "input-required": new Set(["working", "cancelled"]),
};

// Check if a sender is allowed to message a target based on accept_from policy
function isAllowedSender(sender: { id: string; name: string; tier?: string } | "cli", target: Peer): boolean {
  const policy = target.accept_from;
  if (policy === "*") return true;
  if (policy === "orchestrator-only") {
    if (sender === "cli") return true; // CLI is treated as orchestrator
    return (sender.tier as Tier) === "orchestrator";
  }
  // JSON array of allowed peer names
  try {
    const allowed = JSON.parse(policy) as string[];
    if (sender === "cli") return allowed.includes("cli");
    return allowed.includes(sender.name) || allowed.includes(sender.id);
  } catch {
    // Single name
    if (sender === "cli") return policy === "cli";
    return policy === (sender as Peer).name || policy === (sender as Peer).id;
  }
}

db.run(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  content TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0
)`);

function genId(): string {
  const c = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

function now(): string {
  return new Date().toISOString();
}

function cleanStale() {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const stale = db
    .query("SELECT id FROM peers WHERE last_seen < ?")
    .all(cutoff) as { id: string }[];
  for (const { id } of stale) {
    db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [id]);
    db.run("DELETE FROM peers WHERE id = ?", [id]);
  }
  // Clean delivered messages older than 1 hour
  const msgCutoff = new Date(Date.now() - 3_600_000).toISOString();
  db.run("DELETE FROM messages WHERE delivered = 1 AND sent_at < ?", [
    msgCutoff,
  ]);
}

setInterval(cleanStale, 30_000);
cleanStale();

function resolvePeer(nameOrId: string): Peer | null {
  return (
    (db.query("SELECT * FROM peers WHERE name = ?").get(nameOrId) as Peer) ||
    (db.query("SELECT * FROM peers WHERE id = ?").get(nameOrId) as Peer) ||
    null
  );
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function err(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") {
      const { n } = db
        .query("SELECT COUNT(*) as n FROM peers")
        .get() as { n: number };
      return json({ ok: true, peers: n });
    }

    if (req.method !== "POST") return new Response("meshwork broker");

    let body: any;
    try {
      body = await req.json();
    } catch {
      return err("invalid json");
    }

    if (path === "/register") {
      let { name, pid, cwd, tier, channel, accept_from } = body;
      if (!name || !pid || !cwd) return err("name, pid, cwd required");
      tier = (tier && ["observer", "worker", "orchestrator"].includes(tier)) ? tier : "worker";
      channel = channel || "default";
      accept_from = accept_from || "*";

      // If name is taken by a different live process, deduplicate
      const existing = db
        .query("SELECT * FROM peers WHERE name = ?")
        .get(name) as PeerRegistration | null;
      if (existing && existing.pid !== pid) {
        // Check if existing is actually alive
        try {
          process.kill(existing.pid, 0);
          // Alive — append suffix
          let n = 2;
          while (
            db.query("SELECT 1 FROM peers WHERE name = ?").get(`${name}-${n}`)
          )
            n++;
          name = `${name}-${n}`;
        } catch {
          // Dead — reclaim the name
          db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [
            existing.id,
          ]);
          db.run("DELETE FROM peers WHERE id = ?", [existing.id]);
        }
      } else if (existing && existing.pid === pid) {
        // Re-registering same process — update and return existing token
        db.run("UPDATE peers SET last_seen = ?, cwd = ?, tier = ?, channel = ?, accept_from = ? WHERE id = ?", [
          now(),
          cwd,
          tier,
          channel,
          accept_from,
          existing.id,
        ]);
        return json({ id: existing.id, name: existing.name, token: existing.token, tier, channel });
      }

      const id = genId();
      const token = genToken();
      const ts = now();
      db.run(
        "INSERT INTO peers (id, name, token, pid, cwd, tier, channel, accept_from, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, name, token, pid, cwd, tier, channel, accept_from, ts, ts]
      );
      return json({ id, name, token, tier, channel });
    }

    if (path === "/unregister") {
      const peer = authenticate(body);
      if (!peer) return err("invalid id or token", 401);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      return json({ ok: true });
    }

    if (path === "/heartbeat") {
      const peer = authenticate(body);
      if (!peer) return err("invalid id or token", 401);
      db.run("UPDATE peers SET last_seen = ? WHERE id = ?", [now(), peer.id]);
      return json({ ok: true });
    }

    if (path === "/set-status") {
      const peer = authenticate(body);
      if (!peer) return err("invalid id or token", 401);
      db.run("UPDATE peers SET status = ?, last_seen = ? WHERE id = ?", [
        body.status || "",
        now(),
        peer.id,
      ]);
      return json({ ok: true });
    }

    if (path === "/peers") {
      const exclude = body.exclude || "";
      const channel = body.channel || null;
      let query = "SELECT id, name, pid, cwd, status, tier, channel, accept_from, registered_at, last_seen FROM peers WHERE id != ?";
      const params: any[] = [exclude];
      if (channel) {
        query += " AND channel = ?";
        params.push(channel);
      }
      const peers = db.query(query).all(...params) as Peer[];
      return json(peers);
    }

    if (path === "/send") {
      const { to, content } = body;

      // Authenticate sender — CLI gets a pass with from_id: "cli"
      let sender: Peer | null = null;
      let senderId: string;
      let senderTier: Tier;
      if (body.from_id === "cli") {
        // CLI direct send — treated as orchestrator, no token needed
        senderId = "cli";
        senderTier = "orchestrator";
      } else {
        sender = authenticate(body);
        if (!sender) return err("invalid id or token", 401);
        senderId = sender.id;
        senderTier = sender.tier as Tier;
      }

      if (!to || !content) return err("to, content required");
      if (content.length > 65_536) return err("content exceeds 64KB limit");

      // Observers cannot send messages
      if (senderTier === "observer") {
        return err("observer tier cannot send messages", 403);
      }

      const target = resolvePeer(to);
      if (!target) return err(`peer not found: ${to}`, 404);

      // Channel scoping: peers can only message within the same channel (CLI exempt)
      if (sender && sender.channel !== target.channel) {
        return err(`cannot send across channels: you are in "${sender.channel}", target "${target.name}" is in "${target.channel}"`, 403);
      }

      // Workers can only send to orchestrators
      if (senderTier === "worker" && (target.tier as Tier) !== "orchestrator") {
        return err(`worker tier can only send to orchestrators, not to ${target.tier} "${target.name}"`, 403);
      }

      // Allowlist check
      const senderInfo = sender ? { id: sender.id, name: sender.name, tier: sender.tier } : "cli" as const;
      if (!isAllowedSender(senderInfo, target)) {
        return err(`"${target.name}" does not accept messages from you (policy: ${target.accept_from})`, 403);
      }

      const ts = now();
      const result = db.run(
        "INSERT INTO messages (from_id, to_id, content, sent_at) VALUES (?, ?, ?, ?)",
        [senderId, target.id, content, ts]
      );
      return json({ id: Number(result.lastInsertRowid), to_id: target.id, to_name: target.name });
    }

    if (path === "/poll") {
      const peer = authenticate(body);
      if (!peer) return err("invalid id or token", 401);

      const msgs = db
        .query(
          `SELECT m.id, m.from_id, p.name as from_name, p.tier as from_tier, m.to_id, m.content, m.sent_at
           FROM messages m LEFT JOIN peers p ON m.from_id = p.id
           WHERE m.to_id = ? AND m.delivered = 0
           ORDER BY m.id ASC`
        )
        .all(peer.id) as (Message & { from_tier?: string })[];
      return json(msgs);
    }

    if (path === "/ack") {
      const peer = authenticate(body);
      if (!peer) return err("invalid id or token", 401);
      const { message_ids } = body;
      if (!Array.isArray(message_ids)) return err("message_ids array required");
      if (message_ids.length > 0) {
        const placeholders = message_ids.map(() => "?").join(",");
        db.run(
          `UPDATE messages SET delivered = 1 WHERE id IN (${placeholders})`,
          message_ids
        );
      }
      return json({ ok: true });
    }

    // --- Task endpoints ---

    if (path === "/task/create") {
      const sender = body.from_id === "cli"
        ? null
        : authenticate(body);
      if (body.from_id !== "cli" && !sender) return err("invalid id or token", 401);

      const senderId = sender ? sender.id : "cli";
      const senderTier: Tier = sender ? sender.tier as Tier : "orchestrator";

      if (senderTier !== "orchestrator") {
        return err("only orchestrators can create tasks", 403);
      }

      const { to, description } = body;
      if (!to || !description) return err("to, description required");

      const target = resolvePeer(to);
      if (!target) return err(`peer not found: ${to}`, 404);

      // Channel scoping
      if (sender && sender.channel !== target.channel) {
        return err(`cannot delegate across channels`, 403);
      }

      // Allowlist check
      const senderInfo = sender ? { id: sender.id, name: sender.name, tier: sender.tier } : "cli" as const;
      if (!isAllowedSender(senderInfo, target)) {
        return err(`"${target.name}" does not accept messages from you`, 403);
      }

      const taskId = genId();
      const ts = now();
      const channel = sender ? sender.channel : target.channel;
      db.run(
        "INSERT INTO tasks (id, from_id, to_id, channel, description, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?)",
        [taskId, senderId, target.id, channel, description, ts, ts]
      );

      // Also send a message to the target so they get notified via channel push
      db.run(
        "INSERT INTO messages (from_id, to_id, content, sent_at) VALUES (?, ?, ?, ?)",
        [senderId, target.id, `[TASK:${taskId}] ${description}`, ts]
      );

      return json({ id: taskId, to_id: target.id, to_name: target.name, state: "submitted" });
    }

    if (path === "/task/update") {
      const peer = authenticate(body);
      if (!peer) return err("invalid id or token", 401);

      const { task_id, state, result: taskResult } = body;
      if (!task_id || !state) return err("task_id, state required");
      if (!VALID_TASK_STATES.has(state as TaskState)) return err(`invalid state: ${state}`);

      const task = db.query("SELECT * FROM tasks WHERE id = ?").get(task_id) as Task | null;
      if (!task) return err(`task not found: ${task_id}`, 404);

      // Only the assignee can update task state
      if (task.to_id !== peer.id) {
        return err("only the assigned peer can update task state", 403);
      }

      // Validate state transition
      const allowed = TASK_TRANSITIONS[task.state];
      if (!allowed || !allowed.has(state)) {
        return err(`invalid transition: ${task.state} → ${state}`, 400);
      }

      const ts = now();
      db.run(
        "UPDATE tasks SET state = ?, result = ?, updated_at = ? WHERE id = ?",
        [state, taskResult || task.result, ts, task_id]
      );

      // Notify the task creator if terminal or input-required
      if (["completed", "failed", "input-required"].includes(state)) {
        const label = state === "input-required" ? "NEEDS INPUT" : state.toUpperCase();
        const msg = taskResult
          ? `[TASK:${task_id}:${label}] ${taskResult}`
          : `[TASK:${task_id}:${label}]`;
        db.run(
          "INSERT INTO messages (from_id, to_id, content, sent_at) VALUES (?, ?, ?, ?)",
          [peer.id, task.from_id, msg, ts]
        );
      }

      return json({ ok: true, task_id, state });
    }

    if (path === "/task/get") {
      const peer = authenticate(body);
      if (!peer) {
        // Allow CLI
        if (body.from_id !== "cli") return err("invalid id or token", 401);
      }

      const { task_id } = body;
      if (!task_id) return err("task_id required");

      const task = db.query(
        `SELECT t.*, p1.name as from_name, p2.name as to_name
         FROM tasks t
         LEFT JOIN peers p1 ON t.from_id = p1.id
         LEFT JOIN peers p2 ON t.to_id = p2.id
         WHERE t.id = ?`
      ).get(task_id) as (Task & { from_name?: string; to_name?: string }) | null;

      if (!task) return err(`task not found: ${task_id}`, 404);
      return json(task);
    }

    if (path === "/task/list") {
      const peer = authenticate(body);
      if (!peer) {
        if (body.from_id !== "cli") return err("invalid id or token", 401);
      }

      const peerId = peer ? peer.id : null;
      const channel = peer ? peer.channel : body.channel || "default";
      const stateFilter = body.state || null;

      let query = `SELECT t.*, p1.name as from_name, p2.name as to_name
                   FROM tasks t
                   LEFT JOIN peers p1 ON t.from_id = p1.id
                   LEFT JOIN peers p2 ON t.to_id = p2.id
                   WHERE t.channel = ?`;
      const params: any[] = [channel];

      // If a peer is asking, show tasks they created or are assigned to
      if (peerId) {
        query += " AND (t.from_id = ? OR t.to_id = ?)";
        params.push(peerId, peerId);
      }

      if (stateFilter) {
        query += " AND t.state = ?";
        params.push(stateFilter);
      }

      query += " ORDER BY t.created_at DESC LIMIT 50";
      const tasks = db.query(query).all(...params) as Task[];
      return json(tasks);
    }

    return err("not found", 404);
  },
});

console.log(`meshwork broker running on 127.0.0.1:${PORT}`);
