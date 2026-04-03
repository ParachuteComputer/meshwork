import { Database } from "bun:sqlite";
import { resolve } from "path";
import { homedir } from "os";
import type { Peer, Message } from "./types.ts";

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
  pid INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  registered_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
)`);

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
      let { name, pid, cwd } = body;
      if (!name || !pid || !cwd) return err("name, pid, cwd required");

      // If name is taken by a different live process, deduplicate
      const existing = db
        .query("SELECT * FROM peers WHERE name = ?")
        .get(name) as Peer | null;
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
        // Re-registering same process — update and return existing
        db.run("UPDATE peers SET last_seen = ?, cwd = ? WHERE id = ?", [
          now(),
          cwd,
          existing.id,
        ]);
        return json({ id: existing.id, name: existing.name });
      }

      const id = genId();
      const ts = now();
      db.run(
        "INSERT INTO peers (id, name, pid, cwd, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)",
        [id, name, pid, cwd, ts, ts]
      );
      return json({ id, name });
    }

    if (path === "/unregister") {
      const { id } = body;
      if (!id) return err("id required");
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [id]);
      db.run("DELETE FROM peers WHERE id = ?", [id]);
      return json({ ok: true });
    }

    if (path === "/heartbeat") {
      const { id } = body;
      if (!id) return err("id required");
      db.run("UPDATE peers SET last_seen = ? WHERE id = ?", [now(), id]);
      return json({ ok: true });
    }

    if (path === "/set-status") {
      const { id, status } = body;
      if (!id) return err("id required");
      db.run("UPDATE peers SET status = ?, last_seen = ? WHERE id = ?", [
        status || "",
        now(),
        id,
      ]);
      return json({ ok: true });
    }

    if (path === "/peers") {
      const exclude = body.exclude || "";
      const peers = db
        .query("SELECT * FROM peers WHERE id != ?")
        .all(exclude) as Peer[];
      return json(peers);
    }

    if (path === "/send") {
      const { from_id, to, content } = body;
      if (!from_id || !to || !content)
        return err("from_id, to, content required");

      if (content.length > 65_536) return err("content exceeds 64KB limit");

      const target = resolvePeer(to);
      if (!target) return err(`peer not found: ${to}`, 404);

      const ts = now();
      const result = db.run(
        "INSERT INTO messages (from_id, to_id, content, sent_at) VALUES (?, ?, ?, ?)",
        [from_id, target.id, content, ts]
      );
      return json({ id: Number(result.lastInsertRowid), to_id: target.id, to_name: target.name });
    }

    if (path === "/poll") {
      const { id } = body;
      if (!id) return err("id required");

      const msgs = db
        .query(
          `SELECT m.id, m.from_id, p.name as from_name, m.to_id, m.content, m.sent_at
           FROM messages m LEFT JOIN peers p ON m.from_id = p.id
           WHERE m.to_id = ? AND m.delivered = 0
           ORDER BY m.id ASC`
        )
        .all(id) as Message[];
      return json(msgs);
    }

    if (path === "/ack") {
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

    return err("not found", 404);
  },
});

console.log(`meshwork broker running on 127.0.0.1:${PORT}`);
