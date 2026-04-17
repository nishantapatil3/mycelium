// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Julia Valenti

/**
 * Forward agent output and conversations to the Mycelium knowledge graph.
 *
 * Captures comprehensive agent interactions including:
 * - Outgoing messages (`message_sent`) - agent sending to others
 * - Incoming messages (`message_received`) - agent receiving from others
 * - Complete subagent conversations (`subagent_ended`) - full conversation history
 * - LLM prompts and responses (`llm_input`, `llm_output`) - full context
 *
 * All captured content is POSTed to `/api/knowledge/ingest` for semantic search
 * and memory retrieval via "mycelium memory get...". This enables accurate
 * context retrieval from agent-agent interactions.
 *
 * Separate from the mycelium-knowledge-extract HOOK (which runs out-of-process
 * via OpenClaw's hook system) — this is the in-process plugin-level shim.
 *
 * Also POSTs broadcast replies to the configured Mycelium room if one exists
 * in the session entry (so agents writing to e.g. Discord also land in the
 * linked Mycelium room).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  type ChannelConfig,
  getApiUrl,
  getAgentId,
  getMasId,
  getWorkspaceId,
  resolveHandle,
} from "../config.js";

type Logger = { info: (s: string) => void; warn: (s: string) => void };

type RoomContext = {
  roomName: string;
  namespaceRoom: string;
  workspaceId: string | null;
  masId: string | null;
};

const INGEST_LOG_PATH = join(homedir(), ".openclaw", "ingest-kg-plugin.log");

async function writeIngestLog(level: "INFO" | "WARN", message: string): Promise<void> {
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  try {
    await appendFile(INGEST_LOG_PATH, line, "utf-8");
  } catch {
    // Avoid surfacing file logger failures into the plugin event path.
  }
}

export function installKnowledgeIngest(
  api: OpenClawPluginApi,
  channelCfg: ChannelConfig | null,
  _log: Logger,
): void {
  const fileLog: Logger = {
    info: (message: string) => {
      void writeIngestLog("INFO", message);
    },
    warn: (message: string) => {
      void writeIngestLog("WARN", message);
    },
  };

  const logMasId = (): string => cachedRoomContext?.masId || getMasId() || "unset";
  const cfnLog = (
    level: "info" | "warn",
    message: string,
  ): void => {
    const line = `[mycelium-cfn] mas_id=${logMasId()} ${message}`;
    if (level === "warn") {
      fileLog.warn(line);
      return;
    }
    fileLog.info(line);
  };

  let cachedRoomContext: RoomContext | null = null;
  let cachedRoomContextAt = 0;
  let roomContextPromise: Promise<RoomContext | null> | null = null;

  const roomApiGet = async (path: string): Promise<unknown> => {
    const base = channelCfg?.backendUrl || getApiUrl();
    if (!base) {
      fileLog.warn(`[mycelium] GET ${path} error: missing API URL`);
      return null;
    }
    try {
      const res = await fetch(`${base}${path}`);
      if (!res.ok) {
        fileLog.warn(`[mycelium] GET ${path} → ${res.status}`);
        return null;
      }
      return await res.json();
    } catch (err) {
      fileLog.warn(`[mycelium] GET ${path} error: ${err}`);
      return null;
    }
  };

  const roomApiPost = async (path: string, body: unknown): Promise<boolean> => {
    const base = channelCfg?.backendUrl || getApiUrl();
    if (!base) {
      fileLog.warn(`[mycelium] POST ${path} error: missing API URL`);
      return false;
    }
    try {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        fileLog.warn(`[mycelium] POST ${path} → ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      fileLog.warn(`[mycelium] POST ${path} error: ${err}`);
      return false;
    }
  };

  const resolveRoomContext = async (): Promise<RoomContext | null> => {
    const fallback = {
      workspaceId: getWorkspaceId() || null,
      masId: getMasId() || null,
    };
    const roomName = channelCfg?.room?.trim();
    if (!roomName) {
      return fallback.workspaceId || fallback.masId
        ? {
            roomName: "(config)",
            namespaceRoom: "(config)",
            workspaceId: fallback.workspaceId,
            masId: fallback.masId,
          }
        : null;
    }

    const now = Date.now();
    if (cachedRoomContext && now - cachedRoomContextAt < 10_000) {
      return cachedRoomContext;
    }
    if (roomContextPromise) {
      return roomContextPromise;
    }

    roomContextPromise = (async () => {
      const encodedRoom = encodeURIComponent(roomName);
      const room = (await roomApiGet(`/rooms/${encodedRoom}`)) as
        | {
            name?: string;
            parent_namespace?: string | null;
            workspace_id?: string | null;
            mas_id?: string | null;
          }
        | null;

      if (!room) {
        const result = fallback.workspaceId || fallback.masId
          ? {
              roomName,
              namespaceRoom: roomName,
              workspaceId: fallback.workspaceId,
              masId: fallback.masId,
            }
          : null;
        cachedRoomContext = result;
        cachedRoomContextAt = now;
        return result;
      }

      let namespaceRoom = room.name || roomName;
      let workspaceId = room.workspace_id || null;
      let masId = room.mas_id || null;

      if ((!workspaceId || !masId) && room.parent_namespace) {
        const encodedParent = encodeURIComponent(room.parent_namespace);
        const parent = (await roomApiGet(`/rooms/${encodedParent}`)) as
          | {
              name?: string;
              workspace_id?: string | null;
              mas_id?: string | null;
            }
          | null;
        if (parent) {
          namespaceRoom = parent.name || room.parent_namespace;
          workspaceId = parent.workspace_id || workspaceId;
          masId = parent.mas_id || masId;
        }
      }

      if (!workspaceId) workspaceId = fallback.workspaceId;
      if (!masId) masId = fallback.masId;

      const result = {
        roomName,
        namespaceRoom,
        workspaceId,
        masId,
      };
      cachedRoomContext = result;
      cachedRoomContextAt = now;
      return result;
    })()
      .finally(() => {
        roomContextPromise = null;
      });

    return roomContextPromise;
  };

  // Helper to ingest content to knowledge graph
  const ingestToKnowledge = async (
    content: string,
    agentId: string | undefined,
    metadata?: Record<string, any>,
  ): Promise<boolean> => {
    if (!content?.trim() || content.trim().length < 5) return false;

    const target = await resolveRoomContext();
    const ws = target?.workspaceId;
    const ms = target?.masId;
    if (!ws || !ms) {
      cfnLog("warn", "skipping ingest: workspace_id or mas_id unresolved");
      return false;
    }

    const ingestAgentId = agentId?.trim() || getAgentId() || undefined;
    const record: Record<string, any> = { response: content };
    if (metadata) {
      Object.assign(record, metadata);
    }

    cfnLog(
      "info",
      `resolved room=${target?.roomName ?? "unknown"} namespace=${target?.namespaceRoom ?? "unknown"}`,
    );

    return roomApiPost(
      "/api/knowledge/ingest",
      {
        workspace_id: ws,
        mas_id: ms,
        agent_id: ingestAgentId,
        records: [record],
      },
    );
  };

  // Capture outgoing messages (agent sending to others)
  api.on(
    "message_sent",
    async (
      event: { to: string; content: string; success: boolean },
      ctx: any,
    ) => {
      cfnLog("info", `event=message_sent success=${event.success}`);
      if (!event.success) return;

      const agentId: string | undefined = ctx?.agentId;
      const handle = resolveHandle(agentId);

      if (channelCfg?.room) {
        await roomApiPost(
          `/rooms/${channelCfg.room}/messages`,
          {
            sender_handle: handle,
            recipient_handle: null,
            message_type: "broadcast",
            content: event.content,
          },
        );
      }

      await ingestToKnowledge(event.content, agentId, {
        message_type: "sent",
        recipient: event.to,
      });
    },
  );

  // Capture incoming messages (agent receiving from others)
  api.on(
    "message_received",
    async (
      event: { from: string; content: string; timestamp?: string },
      ctx: any,
    ) => {
      cfnLog("info", `event=message_received from=${event.from}`);
      const agentId: string | undefined = ctx?.agentId;
      await ingestToKnowledge(event.content, agentId, {
        message_type: "received",
        sender: event.from,
        timestamp: event.timestamp,
      });
    },
  );

  // Capture complete subagent conversations when they finish
  api.on(
    "subagent_ended",
    async (
      event: { targetSessionKey: string; outcome: string; reason?: string },
      ctx: any,
    ) => {
      cfnLog(
        "info",
        `event=subagent_ended session=${event.targetSessionKey} outcome=${event.outcome}`,
      );
      try {
        // Get complete conversation history from subagent
        const { messages } = await api.runtime.subagent.getSessionMessages({
          sessionKey: event.targetSessionKey,
          limit: 500, // Capture up to 500 messages
        });

        if (!messages || messages.length === 0) return;

        // Extract conversation as structured text
        const conversationParts: string[] = [];
        conversationParts.push(`=== Subagent Conversation ===`);
        conversationParts.push(`Session: ${event.targetSessionKey}`);
        conversationParts.push(`Outcome: ${event.outcome}`);
        if (event.reason) conversationParts.push(`Reason: ${event.reason}`);
        conversationParts.push(`Messages: ${messages.length}`);
        conversationParts.push("");

        // Process each message
        for (const msg of messages) {
          conversationParts.push(`--- ${msg.role.toUpperCase()} ---`);

          if (typeof msg.content === "string") {
            conversationParts.push(msg.content);
          } else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "text") {
                conversationParts.push(block.text);
              } else if (block.type === "tool_use") {
                conversationParts.push(
                  `[Tool: ${block.name}] ${JSON.stringify(block.input)}`,
                );
              } else if (block.type === "tool_result") {
                const content =
                  typeof block.content === "string"
                    ? block.content
                    : JSON.stringify(block.content);
                conversationParts.push(`[Tool Result] ${content}`);
              }
            }
          }
          conversationParts.push("");
        }

        const fullConversation = conversationParts.join("\n");

        // Ingest the complete conversation
        const agentId: string | undefined = ctx?.agentId;
        const ingested = await ingestToKnowledge(fullConversation, agentId, {
          message_type: "subagent_conversation",
          session_key: event.targetSessionKey,
          outcome: event.outcome,
          message_count: messages.length,
        });

        if (ingested) {
          cfnLog(
            "info",
            `Ingested subagent conversation: ${event.targetSessionKey} (${messages.length} messages)`,
          );
        }
      } catch (err) {
        cfnLog("warn", `Failed to ingest subagent conversation: ${err}`);
      }
    },
  );

  // Capture LLM prompts for full context
  api.on(
    "llm_input",
    async (
      event: {
        runId?: string;
        sessionId?: string;
        provider?: string;
        model?: string;
        prompt?: string;
        systemPrompt?: string;
        historyMessages?: any[];
      },
      ctx: any,
    ) => {
      cfnLog("info", `event=llm_input run_id=${event.runId ?? "unknown"}`);
      const agentId: string | undefined = ctx?.agentId;
      const sessionKey = ctx?.sessionKey || "main";

      // Build full context including system prompt and history
      const contextParts: string[] = [];
      contextParts.push(`=== LLM Input ===`);
      contextParts.push(`Session: ${sessionKey}`);
      if (event.model) contextParts.push(`Model: ${event.model}`);
      contextParts.push("");

      if (event.systemPrompt) {
        contextParts.push("--- System Prompt ---");
        contextParts.push(event.systemPrompt);
        contextParts.push("");
      }

      if (event.prompt) {
        contextParts.push("--- User Prompt ---");
        contextParts.push(event.prompt);
      }

      const fullContext = contextParts.join("\n");
      await ingestToKnowledge(fullContext, agentId, {
        message_type: "llm_input",
        session_key: sessionKey,
        run_id: event.runId,
        model: event.model,
      });
    },
  );

  // Capture LLM responses for full context
  api.on(
    "llm_output",
    async (
      event: {
        runId?: string;
        sessionId?: string;
        provider?: string;
        model?: string;
        assistantTexts?: string[];
        usage?: {
          input?: number;
          output?: number;
          total?: number;
        };
      },
      ctx: any,
    ) => {
      cfnLog("info", `event=llm_output run_id=${event.runId ?? "unknown"}`);
      if (!event.assistantTexts || event.assistantTexts.length === 0) return;

      const agentId: string | undefined = ctx?.agentId;
      const sessionKey = ctx?.sessionKey || "main";

      // Combine all assistant texts
      const fullResponse = event.assistantTexts.join("\n\n");

      await ingestToKnowledge(fullResponse, agentId, {
        message_type: "llm_output",
        session_key: sessionKey,
        run_id: event.runId,
        model: event.model,
        token_usage: event.usage,
      });
    },
  );
}
