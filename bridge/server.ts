import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolve, basename } from "path";
import type { Peer, Message } from "./types.ts";

const BROKER_PORT = parseInt(process.env.MESHWORK_PORT || "7899");
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL = 1000;
const HEARTBEAT_INTERVAL = 15_000;

let myId = "";
let myName = "";
const cwd = process.cwd();

// --- Broker communication ---

async function brokerPost(path: string, body: object = {}): Promise<any> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// --- Auto-launch broker ---

async function ensureBroker(): Promise<void> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) return;
  } catch {}

  const brokerPath = resolve(import.meta.dir, "broker.ts");
  const proc = Bun.spawn([process.execPath, brokerPath], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env },
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await Bun.sleep(200);
    try {
      const res = await fetch(`${BROKER_URL}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return;
    } catch {}
  }
  throw new Error("Failed to start broker");
}

// --- MCP Server ---

const server = new Server(
  { name: "meshwork", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You have access to a peer communication bridge that connects you to other Claude Code sessions on this machine.

When you receive a <channel source="meshwork"> message, treat it like a coworker reaching out — read it and respond promptly. If it's a task, do the work and send back results. If it's a question, answer it. If it's informational, acknowledge briefly.

Use send_peer_message to talk to peers. Use list_peers to see who's available.

Call set_my_status early in your session to let peers know what you're working on.`,
  }
);

// --- Tool definitions ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_peers",
      description:
        "List all active Claude Code sessions on this machine that are connected to the bridge",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "send_peer_message",
      description:
        "Send a message to another Claude Code session. Address by name or ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: {
            type: "string",
            description: "Peer name or ID to send to",
          },
          message: {
            type: "string",
            description: "Message content",
          },
        },
        required: ["to", "message"],
      },
    },
    {
      name: "check_messages",
      description:
        "Manually check for pending messages. Usually not needed — messages arrive automatically via channel push.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "set_my_status",
      description:
        "Set a short status message so other peers know what you're working on",
      inputSchema: {
        type: "object" as const,
        properties: {
          status: {
            type: "string",
            description: "What you're currently working on",
          },
        },
        required: ["status"],
      },
    },
    {
      name: "whoami",
      description: "Get your own peer identity (name and ID) on the bridge",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ],
}));

// --- Tool handlers ---

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "list_peers") {
    const peers = (await brokerPost("/peers", {
      exclude: myId,
    })) as Peer[];
    if (peers.length === 0) {
      return { content: [{ type: "text", text: "No other peers connected." }] };
    }
    const lines = peers.map(
      (p) =>
        `• ${p.name} (${p.id}) — ${p.status || "no status"} — ${p.cwd}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (name === "send_peer_message") {
    const { to, message } = args as { to: string; message: string };
    const result = await brokerPost("/send", {
      from_id: myId,
      to,
      content: message,
    });
    if (result.error) {
      return {
        content: [{ type: "text", text: `Failed: ${result.error}` }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Message sent to ${result.to_name} (${result.to_id})`,
        },
      ],
    };
  }

  if (name === "check_messages") {
    const msgs = await pollMessages();
    if (msgs.length === 0) {
      return { content: [{ type: "text", text: "No pending messages." }] };
    }
    const lines = msgs.map(
      (m) => `[${m.from_name || m.from_id}]: ${m.content}`
    );
    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }

  if (name === "set_my_status") {
    const { status } = args as { status: string };
    await brokerPost("/set-status", { id: myId, status });
    return {
      content: [{ type: "text", text: `Status updated: ${status}` }],
    };
  }

  if (name === "whoami") {
    return {
      content: [
        {
          type: "text",
          text: `Name: ${myName}\nID: ${myId}\nDirectory: ${cwd}`,
        },
      ],
    };
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

// --- Message polling and channel push ---

async function pollMessages(): Promise<Message[]> {
  const msgs = (await brokerPost("/poll", { id: myId })) as Message[];
  if (msgs.length > 0) {
    for (const msg of msgs) {
      try {
        await server.notification({
          method: "notifications/claude/channel",
          params: {
            content: msg.content,
            meta: {
              from: msg.from_name || msg.from_id,
              from_id: msg.from_id,
              sent_at: msg.sent_at,
            },
          },
        });
      } catch {
        return msgs;
      }
    }
    await brokerPost("/ack", { message_ids: msgs.map((m) => m.id) });
  }
  return msgs;
}

let pollTimer: ReturnType<typeof setInterval>;
let heartbeatTimer: ReturnType<typeof setInterval>;
let brokerHealthy = true;

async function reregister() {
  try {
    await ensureBroker();
    const reg = await brokerPost("/register", {
      name: myName,
      pid: process.pid,
      cwd,
    });
    myId = reg.id;
    myName = reg.name;
    brokerHealthy = true;
  } catch {}
}

function startPolling() {
  pollTimer = setInterval(async () => {
    try {
      await pollMessages();
      brokerHealthy = true;
    } catch {
      if (brokerHealthy) {
        brokerHealthy = false;
        await reregister();
      }
    }
  }, POLL_INTERVAL);

  heartbeatTimer = setInterval(async () => {
    try {
      await brokerPost("/heartbeat", { id: myId });
      brokerHealthy = true;
    } catch {
      if (brokerHealthy) {
        brokerHealthy = false;
        await reregister();
      }
    }
  }, HEARTBEAT_INTERVAL);
}

// --- Lifecycle ---

async function shutdown() {
  clearInterval(pollTimer);
  clearInterval(heartbeatTimer);
  try {
    await brokerPost("/unregister", { id: myId });
  } catch {}
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Main ---

async function main() {
  await ensureBroker();

  const peerName = process.env.MW_NAME || basename(cwd);

  const reg = await brokerPost("/register", {
    name: peerName,
    pid: process.pid,
    cwd,
  });
  myId = reg.id;
  myName = reg.name;

  const transport = new StdioServerTransport();
  await server.connect(transport);

  startPolling();
}

main().catch((e) => {
  console.error("meshwork server failed to start:", e);
  process.exit(1);
});
