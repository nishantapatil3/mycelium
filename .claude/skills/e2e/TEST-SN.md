---
name: e2e
description: Run end-to-end smoke tests for the Mycelium stack. Verifies install, memory, search, coordination, and OpenClaw integration. Use when validating a release, after a deploy, or when something feels broken.
argument-hint: "[--full | --quick | --openclaw]"
---

# End-to-End Testing

Run structured smoke tests against the live Mycelium stack. Tests are cumulative — each phase depends on the previous one passing.

## Arguments

- `--quick` — Stack health + CFN health only (< 1 min)
- `--full` — Quick + OpenClaw agent wake/respond test (~ 5 min, requires gateway running)
- No argument — defaults to `--full`


## Phase 1: Stack Health

Verify all services are running and healthy.

```bash
# 1. Backend health
curl -sf http://localhost:8000/health | python3 -m json.tool
# Expect: status=ok, database.status=ok, embedding.status=ok, llm.status=ok

# 2. Container status
docker ps --format "table {{.Names}}\t{{.Status}}" | grep -E "mycelium|ioc"
# Expect: all containers healthy

# 3. CFN mgmt plane (if IoC enabled)
curl -sf http://localhost:9000/health
# Expect: {"status":"healthy"}

# 4. CFN node (if IoC enabled)
docker inspect ioc-cognition-fabric-node-svc --format '{{.State.Health.Status}}'
# Expect: healthy
```

**Fail criteria**: Any service unhealthy → stop and diagnose. Do not proceed.

## Phase 2: CFN Health

Test that CFN services are working correctly

**Prerequisites**: OpenClaw running with hook installed, CFN healthy, and a room with CFN enabled.

```bash
# Resolve the room-scoped CFN identifiers from the backend, not from `mycelium config show`.
# `mycelium config show` can have a blank MAS ID even when the room already has one.
ROOM_NAME="${ROOM_NAME:-mycelium_room}"
ROOM_JSON="$(curl -sf "http://localhost:8000/rooms/${ROOM_NAME}")"
WORKSPACE_ID="$(printf '%s' "$ROOM_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["workspace_id"])')"
MAS_ID="$(printf '%s' "$ROOM_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["mas_id"])')"

# 1. Verify hook installed
ls ~/.openclaw/hooks/mycelium-knowledge-extract/handler.js
# Expect: handler.js exists (16K)

# 2. Check hook state directory
if [ -d ~/.openclaw/mycelium-extract-state/ ]; then
  ls ~/.openclaw/mycelium-extract-state/
else
  echo "State dir not created yet (ok before first hook fire)"
fi
# Expect: Either JSON tracking files, or a note that the state dir has not been created yet

# 3. Test knowledge ingest endpoint (writes to CFN graph, not mycelium memory)
curl -sf -X POST http://localhost:8000/api/knowledge/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_id": "'$WORKSPACE_ID'",
    "mas_id": "'$MAS_ID'",
    "agent_id": "e2e-agent",
    "records": [{
      "schema": "openclaw-conversation-v1",
      "extractedAt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
      "session": {"agentId": "e2e-agent", "sessionId": "e2e-test-1", "channel": "default", "cwd": "/tmp"},
      "stats": {"totalEntries": 2, "turns": 1, "toolCallCount": 0, "thinkingTurnCount": 0, "totalCost": 0},
      "turns": [{
        "index": 0,
        "timestamp": null,
        "model": "claude-sonnet-4-6",
        "stopReason": "end_turn",
        "usage": null,
        "userMessage": "What is the best way to cache database queries?",
        "thinking": null,
        "toolCalls": [],
        "response": "Use Redis with a TTL — set keys per query hash, expire after 5 minutes."
      }]
    }]
  }' | python3 -m json.tool
# Expect: {"cfn_response_id": "...", "cfn_message": "Successfully saved X nodes and Y edges...", ...}

# 4. Verify CFN graph received the data
docker logs mycelium-backend --tail 50 | grep "shared-memories.*201"
# Expect: POST to CFN /shared-memories with 201 Created

# 5. Query CFN graph to verify ingested data was stored (direct CFN API call)
curl -sf -X POST "http://localhost:9002/api/workspaces/${WORKSPACE_ID}/multi-agentic-systems/${MAS_ID}/shared-memories/query" \
  -H "Content-Type: application/json" \
  -d '{
    "request_id": "'$(uuidgen)'",
    "intent": "What is the best way to cache database queries?",
    "search_strategy": "semantic_graph_traversal"
  }' | python3 -m json.tool
# Expect: {"response_id": "...", "message": "...Redis with a TTL...query hash...5 minutes..."}
# The response should contain: "Redis", "TTL", "query hash", "5 minutes"

# 6. Query CFN graph using mycelium CLI (proxied through backend)
mycelium cfn query "What is the best way to cache database queries?" \
  --mas "${MAS_ID}"
# Expect: Natural language answer mentioning Redis, TTL, query hash, 5 minutes

# 7. List concepts in CFN graph
mycelium cfn ls --mas "${MAS_ID}" --limit 10
# Expect: JSON with nodes array containing concepts extracted from the conversation

# 8. Note: Knowledge extraction writes to CFN graph, NOT mycelium memory
# mycelium memory ls will NOT show these entries (different storage systems)
# Use `mycelium cfn query` to search CFN graph, `mycelium memory search` for local memory
```

**Fail criteria**:
- 503 from `/api/knowledge/ingest` → LLM auth failure (check `LLM_MODEL` and key in backend env)
- 200 but no CFN log entry → CFN not reachable or mgmt plane down
- Query returns empty results → Data not persisted to CFN graph (check CFN node logs)
- Query returns results but content missing → Extraction/transformation issue in ingestion service
- Hook fires but logs fallback → config.toml missing `apiUrl`/`workspace_id`/`mas_id`


## Phase 3: OpenClaw Integration

Test that OpenClaw agents get woken by coordination ticks and respond autonomously.

**Prerequisites**:
1. OpenClaw gateway running (`openclaw gateway status`)
2. Mycelium adapter installed (`mycelium adapter status openclaw`)
3. Agents configured with `sandbox: off` in `~/.openclaw/openclaw.json`
4. **CRITICAL**: Mycelium binary allowlisted for each agent:
   ```bash
   openclaw approvals allowlist add --agent "agent-alpha" "$(which mycelium)"
   openclaw approvals allowlist add --agent "agent-beta" "$(which mycelium)"
   openclaw gateway restart
   ```
   Without this, agents will prompt for approval every time they try to run mycelium commands.

**Note**: OpenClaw monitors the room name configured in `~/.openclaw/openclaw.json` (channels.mycelium-room.room). This test uses `mycelium_room` (the production standard). To use a different room name, update the config and restart the gateway.

**Test Isolation**: Each test run deletes and recreates the room to ensure a clean CFN knowledge graph. This prevents accumulated knowledge from previous runs affecting negotiation behavior and timing.

```bash
# Verify gateway + plugin
# `openclaw gateway status` may hang on some installs even while the gateway is healthy.
# Prefer checking the process/logs directly.
ps -ef | grep '[o]penclaw-gateway'
grep "mycelium-room.*configured\|mycelium.*Ready" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -5

# Clean slate: delete existing room and CFN graph data
curl -sf -X DELETE http://localhost:8000/rooms/mycelium_room 2>/dev/null || echo "Room doesn't exist yet"

# Create fresh room with new MAS ID (empty CFN graph)
mycelium room create mycelium_room
# Expect: New MAS ID created in CFN

# Create session for this test run and capture the spawned session room name
SESSION_ROOM="$(mycelium session create -r mycelium_room | awk '/Session created:/ {print $3}')"
echo "$SESSION_ROOM"
# Expect: mycelium_room:session:<id>

# Launch both agents
openclaw agent --agent agent-alpha --session-id e2e-oc-1 \
  -m "Run: mycelium session join --handle agent-alpha --room mycelium_room -m 'Position A'" \
  --timeout 60 &

openclaw agent --agent agent-beta --session-id e2e-oc-2 \
  -m "Run: mycelium session join --handle agent-beta --room mycelium_room -m 'Position B'" \
  --timeout 60 &

# Check gateway logs for wake/dispatch events
grep "mycelium.*dispatching\|mycelium.*wake" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -10
# Expect: "dispatching to agent-alpha" and "dispatching to agent-beta"

# Watch the actual session room, not the namespace room.
# Expect: joined events, `session started`, repeated ticks, agent responses, then `consensus`.
mycelium room watch "$SESSION_ROOM"

# Optional direct inspection of the session room API
curl -sf "http://localhost:8000/rooms/${SESSION_ROOM}" | python3 -m json.tool
curl -sf "http://localhost:8000/rooms/${SESSION_ROOM}/messages?limit=50" | python3 -m json.tool
# Expect: coordination_state=negotiating or complete, plus coordination_tick and direct agent messages
```

**Fail criteria**:
- No dispatch events in logs → OpenClaw plugin not discovering session rooms (check `openclaw.json` room name matches)
- Dispatch events but no agent join messages in `mycelium room watch` → Mycelium binary not allowlisted (see Prerequisites #4 above)
- Agents respond conversationally instead of executing commands → Mycelium binary not allowlisted
- Session room stays `idle` after both agents claim they joined → joins never reached the backend; check `POST /rooms/<room>/sessions` in backend logs
- `Plugin runtime subagent methods are only available during a gateway request` → old plugin installed, needs `mycelium adapter add openclaw --reinstall`
- SSE errors with `Failed to parse URL` → `getApiUrl()` returning empty, check `~/.mycelium/config.toml`


---


## Interpreting Failures

| Symptom | Likely cause | Check |
|---------|-------------|-------|
| CFN query returns empty | No data ingested to CFN graph | Check `/api/knowledge/ingest` logs, verify hook fired |
| `mycelium cfn ls` returns empty | CFN graph not populated | Verify ingest succeeded, check CFN node logs |
| Database and filesystem out of sync after restart | Stale files after `down --volumes` | Phase 4 now deletes/recreates room for clean CFN graph each run |
| Ticks never arrive | CFN not configured on room | `curl rooms/{room}` → check mas_id/workspace_id |
| Ticks arrive but agents don't respond | Mycelium binary not allowlisted for agents | Run `openclaw approvals allowlist add --agent <name> "$(which mycelium)"` |
| Consensus has empty assignments | CFN response envelope not normalized | Check `_normalize_cfn_decide_response` |
| Second session reuses completed room | Session cleanup bug | Check `_spawn_session_room` state filter |
| Backend hangs after a few rounds | `_expand_slim` DB session leak | Check for idle-in-transaction in `pg_stat_activity` |
