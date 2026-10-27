# Telemetry Enhancements for Usage Details and Subagent Linking

**Branch:** `yemohyle/main_with_last_logs`
**Date:** April 2026
**Author:** Yevhen Mohylevskyy

## Overview

This changeset makes three categories of improvements to the copilot extension's telemetry system:

1. **Extended token usage measurements** — Add detailed token breakdown fields to `model.modelCall.output` events
2. **Subagent parent request linking** — Add `parentHeaderRequestId` to link subagent telemetry back to the parent agent's HTTP request
3. **Debug logging** — Add `[LLM-DEBUG]` and `[THINKING-TELEMETRY]` logs mirroring telemetry events for real-time debugging

---

## 1. Extended Token Usage Measurements

### Problem

The LLM API responses include detailed usage breakdowns:

```json
{
  "usage": {
    "prompt_tokens": 15842,
    "completion_tokens": 307,
    "total_tokens": 16149,
    "prompt_tokens_details": { "cached_tokens": 13696 },
    "completion_tokens_details": {
      "reasoning_tokens": 153,
      "accepted_prediction_tokens": 0,
      "rejected_prediction_tokens": 0
    }
  }
}
```

However, the `model.modelCall.output` telemetry event only captured three measurements: `promptTokens`, `completionTokens`, and `totalTokens`. The detailed breakdown fields (`cached_tokens`, `reasoning_tokens`, `accepted_prediction_tokens`, `rejected_prediction_tokens`) were discarded.

Note: These fields **were** already captured in OTel inference spans (in `chatMLFetcher.ts`), but **not** in the MSFT internal telemetry events.

### Solution

Extended the `telemetryData.extendedBy()` calls in both API paths to include the detailed fields when available.

### Files Changed

#### `src/platform/endpoint/node/responsesApi.ts` — Responses API (GPT family / OpenAI models)

In `sendCompletionOutputTelemetry()`, the `extendedBy()` call now includes:

```typescript
telemetryData.extendedBy({}, {
    promptTokens: completion.usage.prompt_tokens,
    completionTokens: completion.usage.completion_tokens,
    totalTokens: completion.usage.total_tokens,
    // NEW: detailed token breakdowns (when available)
    ...(completion.usage.prompt_tokens_details && { cachedTokens: ... }),
    ...(completion.usage.completion_tokens_details && {
        reasoningTokens: ...,
        acceptedPredictionTokens: ...,
        rejectedPredictionTokens: ...,
    }),
});
```

#### `src/platform/endpoint/node/messagesApi.ts` — Messages API (Anthropic / Claude models)

Same pattern applied in `processResponseFromMessagesEndpoint()`. Anthropic models construct the `usage` object with `prompt_tokens_details.cached_tokens` (from `cacheReadTokens`) and `completion_tokens_details.reasoning_tokens`, so these values will now flow into telemetry.

### Design Decisions

- **Optional spread pattern** — Uses `...(field && { key: value })` to only include fields when the optional detail objects exist. This avoids sending `undefined` or `NaN` values for models/endpoints that don't return these details.
- **No changes to `APIUsage` type** — The type in `openai.ts` already defines `prompt_tokens_details` and `completion_tokens_details` as optional fields. No type changes needed.
- **NES/Completions API not changed** — The `responseStream.ts` aggregates `Completion.Usage` but doesn't call `extendedBy()` or emit telemetry directly. Its usage data flows through a different path.

### New Measurement Fields in `model.modelCall.output`

| Measurement Key | Source | When Present |
|---|---|---|
| `cachedTokens` | `prompt_tokens_details.cached_tokens` | When the model returns prompt token details |
| `reasoningTokens` | `completion_tokens_details.reasoning_tokens` | When the model returns completion token details |
| `acceptedPredictionTokens` | `completion_tokens_details.accepted_prediction_tokens` | When the model returns completion token details |
| `rejectedPredictionTokens` | `completion_tokens_details.rejected_prediction_tokens` | When the model returns completion token details |

---

## 2. Subagent Parent Request Linking (`parentHeaderRequestId`)

### Problem

When the main agent spawns subagents (search_subagent, execution_subagent), the subagent's telemetry events already include `parentToolCallId` — the LLM's `tool_call_id` that triggered the subagent. However, there was no way to link back to the parent agent's specific HTTP request (`headerRequestId`).

This makes it difficult to correlate a subagent's entire trajectory with the specific parent turn that spawned it, especially in multi-turn conversations where multiple tool calls may have the same conversation ID.

### Solution

Thread the parent's `headerRequestId` (from the fetch response) through to subagent telemetry as `parentHeaderRequestId`. This field appears in:
- `model.modelCall.input` events (for subagent requests)
- `model.modelCall.output` events (for subagent responses)
- `model.request.added` events (for subagent requests)

### Data Flow

```
ToolCallingLoop.runOne()
  │
  ├── fetch() → fetchResult.requestId (= parent's headerRequestId)
  │              ↓
  │     stored as this.lastHeaderRequestId
  │
  ├── [next iteration] createPromptContext()
  │     includes parentHeaderRequestId: this.lastHeaderRequestId
  │              ↓
  │     IBuildPromptContext.parentHeaderRequestId
  │              ↓
  │     [via resolveInput()]
  │     SubagentTool._inputContext.parentHeaderRequestId
  │              ↓
  │     passed to SubagentToolCallingLoop options
  │              ↓
  │     included in telemetryProperties of subagent's fetch()
  │              ↓
  │     flows through chatMLFetcher → TelemetryData.properties
  │              ↓
  │     emitted in model.modelCall.input/output and model.request.added
```

### Files Changed (8 files)

#### `src/extension/prompt/common/intents.ts`
Added `parentHeaderRequestId?: string` to `IBuildPromptContext` interface with JSDoc.

#### `src/extension/intents/node/toolCallingLoop.ts`
- Added `private lastHeaderRequestId: string | undefined` instance field
- After `fetchResult` returns successfully, stores `fetchResult.requestId` as `this.lastHeaderRequestId`
- Includes `parentHeaderRequestId: this.lastHeaderRequestId` in the object returned by `createPromptContext()`

**Why `lastHeaderRequestId` and not just reading it at creation time?**
The `createPromptContext()` is called at the START of each iteration, before `fetch()`. The `headerRequestId` we need is from the PREVIOUS iteration's fetch response (the one that returned tool calls). Hence we store it after each successful fetch and read it in the next iteration's context creation.

#### `src/extension/tools/node/searchSubagentTool.ts`
In `invoke()`, passes `parentHeaderRequestId: this._inputContext?.parentHeaderRequestId` to the `SearchSubagentToolCallingLoop` constructor options.

#### `src/extension/tools/node/executionSubagentTool.ts`
Same as above for `ExecutionSubagentToolCallingLoop`.

#### `src/extension/prompt/node/searchSubagentToolCallingLoop.ts`
- Added `parentHeaderRequestId?: string` to `ISearchSubagentToolCallingLoopOptions`
- In `fetch()`, includes `parentHeaderRequestId: this.options.parentHeaderRequestId` in `telemetryProperties`

#### `src/extension/prompt/node/executionSubagentToolCallingLoop.ts`
Same as above for `IExecutionSubagentToolCallingLoopOptions`.

#### `src/platform/networking/common/networking.ts`
Added `parentHeaderRequestId?: string` to `IChatRequestTelemetryProperties` type with JSDoc.

#### `src/platform/networking/node/chatStream.ts`
In `sendModelCallTelemetry()`, extracts `parentHeaderRequestId` from `telemetryData.properties` and includes it in the `model.modelCall.input`/`output` event properties (same pattern as existing `parentToolCallId`).

### Design Decisions

- **Same pattern as `parentToolCallId`** — The threading follows the exact same path. `parentToolCallId` travels through `invocationOptions.chatStreamToolCallId` (a cast-on property on the VS Code API boundary), while `parentHeaderRequestId` travels through `IBuildPromptContext` → `_inputContext`. Both converge in the subagent loop's `telemetryProperties`.
- **Only affects search_subagent and execution_subagent** — The `parentHeaderRequestId` field is only populated when `IBuildPromptContext.parentHeaderRequestId` is set, which only happens in the `ToolCallingLoop` after a successful fetch. Non-subagent tools that also use `_inputContext` will simply see `undefined` and the field won't appear in telemetry.
- **No changes to VS Code extension API** — No new fields added to `LanguageModelToolInvocationOptions`. The data flows through the internal `IBuildPromptContext` service, not through the public API boundary.

### Comparison with `parentToolCallId`

| Aspect | `parentToolCallId` | `parentHeaderRequestId` |
|---|---|---|
| What it identifies | The LLM's tool_call_id (e.g. `call_xyz`) | The parent's HTTP request tracking ID (UUID) |
| Source | `toolCall.id` from LLM response | `fetchResult.requestId` from fetch response |
| Threading path | `toolCalling.tsx` → invocation options → subagent tool | `ToolCallingLoop` → `IBuildPromptContext` → `_inputContext` → subagent tool |
| Complexity | Simple passthrough (value available at invocation site) | Requires storing across iterations + threading through context |

---

## 3. Debug Logging

### `[LLM-DEBUG]` — Input Messages Sent to LLM

**File:** `src/extension/prompt/node/chatMLFetcher.ts`

Logs the last two assistant messages from the request body right before the LLM call. Handles both:
- **CAPI/Anthropic** messages with `role: 'assistant'`
- **Responses API** input items with `type: 'reasoning'` or `type: 'message'` + `role: 'assistant'`

This is useful for verifying that thinking tokens and assistant context are correctly serialized in the input.

### `[THINKING-TELEMETRY]` — Telemetry Event Mirrors

**File:** `src/platform/networking/node/chatStream.ts`

Logs are emitted at the exact point each telemetry event is sent, showing the full payload:

| Log Point | Event Mirrored | What's Logged |
|---|---|---|
| `sendEngineMessagesTelemetry()` | `engine.messages` | Assistant message JSON (truncated to 4000 chars) |
| `sendIndividualMessagesTelemetry()` | `model.message.added` | Assistant message JSON (truncated to 4000 chars) |
| `sendModelCallTelemetry()` | `model.modelCall.input` / `model.modelCall.output` | Full `{properties, measurements}` including usage fields and parent linking |
| `sendNewRequestAddedTelemetry()` | `model.request.added` | Full `{properties, measurements}` |

These logs allow real-time comparison of what telemetry captures vs. what the LLM actually sent/received, without needing to query the telemetry pipeline.

---

## Testing

All changes are additive (new optional fields, new log lines). No existing behavior is modified.

- **Build:** `npm run build` passes cleanly with no errors
- **Token usage fields:** Will appear in `model.modelCall.output` measurements only when the model returns detailed usage. For models that don't, the events remain unchanged.
- **`parentHeaderRequestId`:** Will appear in subagent telemetry events only. Main agent events are unaffected.
- **Debug logs:** Only visible in the Copilot output channel. No impact on telemetry or functionality.

## Files Summary

| File | Change |
|---|---|
| `src/platform/endpoint/node/responsesApi.ts` | Extended usage measurements |
| `src/platform/endpoint/node/messagesApi.ts` | Extended usage measurements |
| `src/platform/networking/node/chatStream.ts` | `parentHeaderRequestId` in events + debug logging |
| `src/platform/networking/common/networking.ts` | `parentHeaderRequestId` in telemetry type |
| `src/extension/prompt/common/intents.ts` | `parentHeaderRequestId` in `IBuildPromptContext` |
| `src/extension/intents/node/toolCallingLoop.ts` | Store + propagate `lastHeaderRequestId` |
| `src/extension/tools/node/searchSubagentTool.ts` | Pass `parentHeaderRequestId` to loop |
| `src/extension/tools/node/executionSubagentTool.ts` | Pass `parentHeaderRequestId` to loop |
| `src/extension/prompt/node/searchSubagentToolCallingLoop.ts` | Options + telemetry property |
| `src/extension/prompt/node/executionSubagentToolCallingLoop.ts` | Options + telemetry property |
| `src/extension/prompt/node/chatMLFetcher.ts` | `[LLM-DEBUG]` for Responses API |
