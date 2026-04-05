export type Tier = "observer" | "worker" | "orchestrator";

export type TaskState =
  | "submitted"
  | "accepted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "cancelled";

export interface Peer {
  id: string;
  name: string;
  pid: number;
  cwd: string;
  status: string;
  tier: Tier;
  channel: string;
  accept_from: string;
  registered_at: string;
  last_seen: string;
}

export interface PeerRegistration extends Peer {
  token: string;
}

export interface Message {
  id: number;
  from_id: string;
  from_name: string;
  to_id: string;
  content: string;
  sent_at: string;
}

export interface Task {
  id: string;
  from_id: string;
  from_name?: string;
  to_id: string;
  to_name?: string;
  channel: string;
  description: string;
  state: TaskState;
  result: string | null;
  created_at: string;
  updated_at: string;
}
