import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolve, basename } from "path";
import type { Peer, Message, Task, Tier } from "./types.ts";

const BROKER_PORT = parseInt(process.env.MESHWORK_PORT || "7899");
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL = 1000;
const HEARTBEAT_INTERVAL = 15_000;

let myId = "";
let myName = "";
let myToken = "";
const myTier: Tier = (process.env.MW_TIER as Tier) || "worker";
const myChannel = process.env.MW_CHANNEL || "default";
const myAcceptFrom = process.env.MW_ACCEPT_FROM || "*";
const cwd = process.cwd();

// --- Broker communication ---

async function brokerPost(path: string, body: object = {}): Promise<any> {
  // Inject auth credentials on all calls except /register (which returns them)
  const authedBody = path === "/register" ? body : { id: myId, token: myToken, ...body };
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(authedBody),
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

Call set_my_status early in your session to let peers know what you're working on.

Sessions have permission tiers that control what tools are available:
- **observer**: can see peers and receive messages, but cannot send
- **worker**: can send messages to orchestrators, update tasks assigned to you
- **orchestrator**: full access — can message any peer, delegate tasks

Task protocol: orchestrators use delegate_task to assign work. Workers use update_task to report progress through states: submitted → accepted → working → input-required → completed/failed/cancelled. Use request_input when you're blocked and need clarification from the orchestrator.

Messages tagged [TASK:<id>] are task notifications — check your tasks with list_tasks.`,
  }
);

// --- Tier-based tool definitions ---

const TOOL_LIST_PEERS = {
  name: "list_peers",
  description:
    "List all active Claude Code sessions on this machine that are connected to the bridge",
  inputSchema: { type: "object" as const, properties: {} },
};

const TOOL_SEND = {
  name: "send_peer_message",
  description:
    "Send a message to another Claude Code session. Address by name or ID.",
  inputSchema: {
    type: "object" as const,
    properties: {
      to: { type: "string", description: "Peer name or ID to send to" },
      message: { type: "string", description: "Message content" },
    },
    required: ["to", "message"],
  },
};

const TOOL_CHECK = {
  name: "check_messages",
  description:
    "Manually check for pending messages. Usually not needed — messages arrive automatically via channel push.",
  inputSchema: { type: "object" as const, properties: {} },
};

const TOOL_STATUS = {
  name: "set_my_status",
  description:
    "Set a short status message so other peers know what you're working on",
  inputSchema: {
    type: "object" as const,
    properties: {
      status: { type: "string", description: "What you're currently working on" },
    },
    required: ["status"],
  },
};

const TOOL_WHOAMI = {
  name: "whoami",
  description: "Get your own peer identity (name, ID, tier, and channel) on the bridge",
  inputSchema: { type: "object" as const, properties: {} },
};

// --- Task tools ---

const TOOL_DELEGATE_TASK = {
  name: "delegate_task",
  description: "Assign a task to another peer. Returns a task ID to track progress. The target peer receives a notification.",
  inputSchema: {
    type: "object" as const,
    properties: {
      to: { type: "string", description: "Peer name or ID to assign the task to" },
      description: { type: "string", description: "What the task is — be specific about what you need done and any relevant context" },
    },
    required: ["to", "description"],
  },
};

const TOOL_CHECK_TASK = {
  name: "check_task",
  description: "Check the current state of a delegated task",
  inputSchema: {
    type: "object" as const,
    properties: {
      task_id: { type: "string", description: "Task ID to check" },
    },
    required: ["task_id"],
  },
};

const TOOL_LIST_TASKS = {
  name: "list_tasks",
  description: "List tasks — your delegated tasks (as orchestrator) or assigned tasks (as worker). Optionally filter by state.",
  inputSchema: {
    type: "object" as const,
    properties: {
      state: { type: "string", description: "Filter by state: submitted, accepted, working, input-required, completed, failed, cancelled" },
    },
  },
};

const TOOL_UPDATE_TASK = {
  name: "update_task",
  description: "Update the state of a task assigned to you. Valid transitions: submitted→accepted, accepted→working, working→completed/failed/input-required, input-required→working. Include a result message for completed/failed states.",
  inputSchema: {
    type: "object" as const,
    properties: {
      task_id: { type: "string", description: "Task ID" },
      state: { type: "string", description: "New state: accepted, working, completed, failed, input-required, cancelled" },
      result: { type: "string", description: "Result or status message (required for completed/failed, optional for others)" },
    },
    required: ["task_id", "state"],
  },
};

const TOOL_REQUEST_INPUT = {
  name: "request_input",
  description: "Signal that you're blocked on a task and need clarification from the orchestrator. Sets the task to input-required and sends your question.",
  inputSchema: {
    type: "object" as const,
    properties: {
      task_id: { type: "string", description: "Task ID" },
      question: { type: "string", description: "What you need clarified" },
    },
    required: ["task_id", "question"],
  },
};

function toolsForTier(tier: Tier) {
  // Observer: read-only — can see peers, check messages, list tasks
  if (tier === "observer") return [TOOL_LIST_PEERS, TOOL_CHECK, TOOL_LIST_TASKS, TOOL_WHOAMI];
  // Worker: can send to orchestrator, update tasks, request input
  if (tier === "worker") return [TOOL_LIST_PEERS, TOOL_SEND, TOOL_CHECK, TOOL_STATUS, TOOL_LIST_TASKS, TOOL_UPDATE_TASK, TOOL_REQUEST_INPUT, TOOL_WHOAMI];
  // Orchestrator: full access — delegate, check, and manage tasks
  return [TOOL_LIST_PEERS, TOOL_SEND, TOOL_CHECK, TOOL_STATUS, TOOL_DELEGATE_TASK, TOOL_CHECK_TASK, TOOL_LIST_TASKS, TOOL_WHOAMI];
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolsForTier(myTier),
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
      (p) => {
        const ch = p.channel !== "default" ? ` #${p.channel}` : "";
        return `• ${p.name} (${p.id}) [${p.tier}${ch}] — ${p.status || "no status"} — ${p.cwd}`;
      }
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (name === "send_peer_message") {
    const { to, message } = args as { to: string; message: string };
    const result = await brokerPost("/send", { from_id: myId, to, content: message });
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

  if (name === "delegate_task") {
    const { to, description } = args as { to: string; description: string };
    const result = await brokerPost("/task/create", { from_id: myId, to, description });
    if (result.error) {
      return { content: [{ type: "text", text: `Failed: ${result.error}` }], isError: true };
    }
    return {
      content: [{ type: "text", text: `Task ${result.id} delegated to ${result.to_name} (${result.to_id})\nState: ${result.state}` }],
    };
  }

  if (name === "check_task") {
    const { task_id } = args as { task_id: string };
    const task = await brokerPost("/task/get", { task_id }) as Task & { from_name?: string; to_name?: string };
    if ((task as any).error) {
      return { content: [{ type: "text", text: `Failed: ${(task as any).error}` }], isError: true };
    }
    const lines = [
      `Task: ${task.id}`,
      `State: ${task.state}`,
      `From: ${task.from_name || task.from_id}`,
      `To: ${task.to_name || task.to_id}`,
      `Description: ${task.description}`,
      task.result ? `Result: ${task.result}` : null,
      `Created: ${task.created_at}`,
      `Updated: ${task.updated_at}`,
    ].filter(Boolean);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (name === "list_tasks") {
    const { state } = (args || {}) as { state?: string };
    const tasks = await brokerPost("/task/list", { state: state || null }) as Task[];
    if ((tasks as any).error) {
      return { content: [{ type: "text", text: `Failed: ${(tasks as any).error}` }], isError: true };
    }
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return { content: [{ type: "text", text: "No tasks found." }] };
    }
    const lines = tasks.map((t: any) =>
      `• ${t.id} [${t.state}] → ${t.to_name || t.to_id}: ${t.description.slice(0, 80)}${t.description.length > 80 ? "…" : ""}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (name === "update_task") {
    const { task_id, state, result: taskResult } = args as { task_id: string; state: string; result?: string };
    const res = await brokerPost("/task/update", { task_id, state, result: taskResult });
    if (res.error) {
      return { content: [{ type: "text", text: `Failed: ${res.error}` }], isError: true };
    }
    return { content: [{ type: "text", text: `Task ${task_id} updated to: ${state}` }] };
  }

  if (name === "request_input") {
    const { task_id, question } = args as { task_id: string; question: string };
    const res = await brokerPost("/task/update", { task_id, state: "input-required", result: question });
    if (res.error) {
      return { content: [{ type: "text", text: `Failed: ${res.error}` }], isError: true };
    }
    return { content: [{ type: "text", text: `Task ${task_id} marked as input-required. Question sent to orchestrator.` }] };
  }

  if (name === "whoami") {
    return {
      content: [
        {
          type: "text",
          text: `Name: ${myName}\nID: ${myId}\nTier: ${myTier}\nChannel: ${myChannel}\nDirectory: ${cwd}`,
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
      tier: myTier,
      channel: myChannel,
      accept_from: myAcceptFrom,
    });
    myId = reg.id;
    myName = reg.name;
    myToken = reg.token;
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
    tier: myTier,
    channel: myChannel,
    accept_from: myAcceptFrom,
  });
  myId = reg.id;
  myName = reg.name;
  myToken = reg.token;

  const transport = new StdioServerTransport();
  await server.connect(transport);

  startPolling();
}

main().catch((e) => {
  console.error("meshwork server failed to start:", e);
  process.exit(1);
});
