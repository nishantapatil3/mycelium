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

import {
  type ChannelConfig,
  getAgentId,
  getMasId,
  getWorkspaceId,
  resolveHandle,
} from "../config.js";
import { apiPost } from "../http.js";

type Logger = { info: (s: string) => void; warn: (s: string) => void };

export function installKnowledgeIngest(
  api: OpenClawPluginApi,
  channelCfg: ChannelConfig | null,
  log: Logger,
): void {
  // Helper to ingest content to knowledge graph
  const ingestToKnowledge = async (
    content: string,
    agentId: string | undefined,
    metadata?: Record<string, any>,
  ) => {
    if (!content?.trim() || content.trim().length < 5) return;

    const ws = getWorkspaceId();
    const ms = getMasId();
    if (!ws || !ms) return;

    const ingestAgentId = agentId?.trim() || getAgentId() || undefined;
    const record: Record<string, any> = { response: content };
    if (metadata) {
      Object.assign(record, metadata);
    }

    apiPost(
      "/api/knowledge/ingest",
      {
        workspace_id: ws,
        mas_id: ms,
        agent_id: ingestAgentId,
        records: [record],
      },
      log,
    ).catch((err) => log.warn(`[mycelium] ingest failed: ${err}`));
  };

  // Capture outgoing messages (agent sending to others)
  api.on(
    "message_sent",
    async (
      event: { to: string; content: string; success: boolean },
      ctx: any,
    ) => {
      if (!event.success) return;

      const agentId: string | undefined = ctx?.agentId;
      const handle = resolveHandle(agentId);

      if (channelCfg?.room) {
        await apiPost(
          `/rooms/${channelCfg.room}/messages`,
          {
            sender_handle: handle,
            recipient_handle: null,
            message_type: "broadcast",
            content: event.content,
          },
          log,
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
        await ingestToKnowledge(fullConversation, agentId, {
          message_type: "subagent_conversation",
          session_key: event.targetSessionKey,
          outcome: event.outcome,
          message_count: messages.length,
        });

        log.info(
          `[mycelium] Ingested subagent conversation: ${event.targetSessionKey} (${messages.length} messages)`,
        );
      } catch (err) {
        log.warn(
          `[mycelium] Failed to ingest subagent conversation: ${err}`,
        );
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
