# PR Diff Explanation: Extended Telemetry Fields

This PR adds two categories of telemetry improvements:
1. **Extended token usage details** (cachedTokens, reasoningTokens, etc.) to `model.modelCall.output` events
2. **`parentHeaderRequestId`** to subagent telemetry for linking subagent HTTP requests back to the parent agent's request

---

## 1. `extensions/copilot/src/platform/endpoint/node/responsesApi.ts`

**What changed:** Added 4 new measurement fields to the `extendedBy()` call inside `sendCompletionOutputTelemetry()`.

```diff
+  ...(completion.usage.prompt_tokens_details && { cachedTokens: completion.usage.prompt_tokens_details.cached_tokens }),
+  ...(completion.usage.completion_tokens_details && {
+    reasoningTokens: completion.usage.completion_tokens_details.reasoning_tokens,
+    acceptedPredictionTokens: completion.usage.completion_tokens_details.accepted_prediction_tokens,
+    rejectedPredictionTokens: completion.usage.completion_tokens_details.rejected_prediction_tokens,
+  }),
```

**Why:** The Responses API (used for GPT/o-series models) already emits `promptTokens`, `completionTokens`, and `totalTokens` in the `model.modelCall.output` telemetry event. The API response also includes sub-breakdowns in `prompt_tokens_details` and `completion_tokens_details`, but these were being discarded. This change conditionally includes:

- **`cachedTokens`**: Number of prompt tokens served from KV cache (from `prompt_tokens_details.cached_tokens`). Lets us measure cache hit rates and understand cost savings.
- **`reasoningTokens`**: Tokens consumed by model reasoning/chain-of-thought (from `completion_tokens_details.reasoning_tokens`). Critical for o-series models where reasoning tokens are a significant cost driver.
- **`acceptedPredictionTokens`** / **`rejectedPredictionTokens`**: For predicted output features (from `completion_tokens_details`). Tracks how much of a predicted output was accepted vs. rejected by the model.

The spread-with-conditional pattern (`...(x && { key: x.field })`) ensures these fields are only added when the API actually returns the detail objects, avoiding `undefined` values in telemetry.

---

## 2. `extensions/copilot/src/platform/endpoint/node/messagesApi.ts`

**What changed:** Same 4 measurement fields added to the `extendedBy()` call inside `processResponseFromMessagesEndpoint()`.

```diff
-  totalTokens: completion.usage.total_tokens
+  totalTokens: completion.usage.total_tokens,
+  ...(completion.usage.prompt_tokens_details && { cachedTokens: completion.usage.prompt_tokens_details.cached_tokens }),
+  ...(completion.usage.completion_tokens_details && {
+    reasoningTokens: completion.usage.completion_tokens_details.reasoning_tokens,
+    acceptedPredictionTokens: completion.usage.completion_tokens_details.accepted_prediction_tokens,
+    rejectedPredictionTokens: completion.usage.completion_tokens_details.rejected_prediction_tokens,
+  }),
```

**Why:** This is the Anthropic Messages API path (used for Claude models). Same rationale as the Responses API change — these sub-breakdown fields exist in the API response but were not being captured. The Anthropic API uses the same `prompt_tokens_details` / `completion_tokens_details` structure (OpenAI-compatible proxy), so identical extraction logic applies. This ensures both API paths emit the same extended usage measurements.

---

## 3. `extensions/copilot/src/platform/networking/common/networking.ts`

**What changed:** Added `parentHeaderRequestId?: string` to the `IChatRequestTelemetryProperties` type.

```diff
+  /** For a subagent: The headerRequestId from the parent agent's fetch response that triggered this subagent invocation. */
+  parentHeaderRequestId?: string;
```

**Why:** This is the type definition that governs what properties can be included in chat request telemetry. Adding it here is required before any code can pass `parentHeaderRequestId` through the telemetry pipeline. It sits alongside the existing `parentRequestId` and `parentToolCallId` fields, which serve a similar purpose (linking subagent events to the parent). The new field provides a different linkage axis — while `parentToolCallId` links to the specific tool call that spawned the subagent, `parentHeaderRequestId` links to the HTTP request that produced that tool call, enabling join with server-side logs.

---

## 4. `extensions/copilot/src/platform/networking/node/chatStream.ts`

**What changed:** Added `parentHeaderRequestId` extraction and emission in `sendModelCallTelemetry()`.

```diff
+  const parentHeaderRequestId = telemetryData.properties.parentHeaderRequestId;
   ...
+  ...(parentHeaderRequestId && { parentHeaderRequestId }), // Link subagent calls to parent HTTP request
```

**Why:** `sendModelCallTelemetry()` is the function that actually emits `model.modelCall.input` and `model.modelCall.output` telemetry events. It already extracts and conditionally includes `parentToolCallId`. This change does the same for `parentHeaderRequestId` — extracts it from the telemetry properties and includes it in each chunked telemetry event. This means every `model.modelCall.*` event for a subagent will carry the parent's HTTP request ID, enabling a direct join between the subagent's LLM calls and the parent's LLM call that produced the tool invocation.

The minor whitespace changes (blank lines added after `JSON.stringify(message)` and before `telemetryService.sendEnhancedGHTelemetryEvent`) are artifacts of debug log removal and have no functional impact.

---

## 5. `extensions/copilot/src/extension/intents/node/toolCallingLoop.ts`

**What changed:** Three additions:
1. New private field `lastHeaderRequestId: string | undefined`
2. After a successful fetch, store `fetchResult.serverRequestId ?? fetchResult.requestId` into `lastHeaderRequestId`
3. Include `parentHeaderRequestId: this.lastHeaderRequestId` in the object returned by `createPromptContext()`

```diff
+  private lastHeaderRequestId: string | undefined;
   ...
+  parentHeaderRequestId: this.lastHeaderRequestId,
   ...
+  // Store the server's x-request-id from the fetch response for subagent telemetry linking
+  if (fetchResult.type === ChatFetchResponseType.Success) {
+    this.lastHeaderRequestId = fetchResult.serverRequestId ?? fetchResult.requestId;
+  }
```

**Why:** `ToolCallingLoop` orchestrates the multi-turn conversation with the LLM. After each successful fetch (LLM HTTP request), the response carries two IDs: `requestId` (a client-generated UUID sent as the `X-Request-Id` request header) and `serverRequestId` (the server's `x-request-id` response header value, which may differ). We prefer `serverRequestId` because the goal is to join with server-side logs. The `?? fetchResult.requestId` fallback handles the rare case where the server doesn't return the header (in that case `chatMLFetcher.ts` already falls back to the client ID internally, so both values would match anyway). The value is stored on the loop instance (not passed directly) because there's a temporal gap — the fetch happens first, then tool calls are processed later in the same turn. Importantly, the value is captured **once at subagent creation** and stays constant for the entire subagent trajectory — each subagent turn reads from `this.options.parentHeaderRequestId`, not from the parent's mutable field.

The `createPromptContext()` method builds the `IBuildPromptContext` that gets injected into tools, so including `parentHeaderRequestId` here makes it available to any tool that needs it.

---

## 6. `extensions/copilot/src/extension/prompt/common/intents.ts`

**What changed:** Added `parentHeaderRequestId?: string` to the `IBuildPromptContext` interface.

```diff
+  /**
+   * The headerRequestId from the most recent parent fetch response.
+   * Used by subagent tools to link their telemetry back to the parent's HTTP request.
+   */
+  readonly parentHeaderRequestId?: string;
```

**Why:** `IBuildPromptContext` is the interface that carries contextual information from the tool calling loop to tools. Adding this field here allows tools (specifically the subagent tools) to read the parent's header request ID from their input context. This is the type-safe bridge between `ToolCallingLoop` (which stores the value) and the subagent tools (which read it).

---

## 7. `extensions/copilot/src/extension/tools/node/searchSubagentTool.ts`

**What changed:** Passes `parentHeaderRequestId` from the tool's input context to the subagent loop options.

```diff
+  parentHeaderRequestId: this._inputContext?.parentHeaderRequestId,
```

**Why:** When the search subagent tool is invoked, it creates a `SearchSubagentToolCallingLoop`. This line threads the parent's header request ID from the `IBuildPromptContext` (populated by the parent's `ToolCallingLoop`) into the subagent loop's options. This is a simple pass-through — the tool reads it from its context and forwards it.

---

## 8. `extensions/copilot/src/extension/tools/node/executionSubagentTool.ts`

**What changed:** Same as searchSubagentTool — passes `parentHeaderRequestId` through.

```diff
+  parentHeaderRequestId: this._inputContext?.parentHeaderRequestId,
```

**Why:** Identical rationale to the search subagent tool. The execution subagent tool creates an `ExecutionSubagentToolCallingLoop` and threads the parent's header request ID into it.

---

## 9. `extensions/copilot/src/extension/prompt/node/searchSubagentToolCallingLoop.ts`

**What changed:** Two additions:
1. `parentHeaderRequestId?: string` added to `ISearchSubagentToolCallingLoopOptions`
2. `parentHeaderRequestId: this.options.parentHeaderRequestId` included in the telemetry properties passed to `fetch()`

```diff
+  /** The headerRequestId from the parent agent's fetch response that triggered this subagent invocation. */
+  parentHeaderRequestId?: string;
   ...
+  parentHeaderRequestId: this.options.parentHeaderRequestId,
```

**Why:** The subagent tool calling loop is where the subagent's own LLM requests are made. By including `parentHeaderRequestId` in the telemetry properties passed to `fetch()`, it flows into the `TelemetryData` that accompanies the subagent's HTTP request, and ultimately appears in `model.modelCall.input` and `model.modelCall.output` events. This completes the data flow: parent fetch → `lastHeaderRequestId` → `IBuildPromptContext` → subagent tool → subagent loop options → subagent telemetry properties.

---

## 10. `extensions/copilot/src/extension/prompt/node/executionSubagentToolCallingLoop.ts`

**What changed:** Same as searchSubagentToolCallingLoop — options interface extended and value threaded to telemetry.

```diff
+  /** The headerRequestId from the parent agent's fetch response that triggered this subagent invocation. */
+  parentHeaderRequestId?: string;
   ...
+  parentHeaderRequestId: this.options.parentHeaderRequestId,
```

**Why:** Identical to the search subagent loop. Both subagent types need the same telemetry linking capability.

---

## 11. `extensions/copilot/src/extension/prompt/node/chatMLFetcher.ts`

**What changed:** A single blank line added between `usernameToScrub = copilotToken.username;` and `const fetchResult = ...`.

**Why:** This is a no-op whitespace artifact from debug log removal. The debug logging block that was here during development has been removed, leaving only the blank line separator. No functional change.

---

## Data Flow Summary

### Extended Usage Measurements
```
API Response (usage.prompt_tokens_details / completion_tokens_details)
  → responsesApi.ts / messagesApi.ts (extracted in extendedBy())
    → model.modelCall.output telemetry event (as measurements)
```

### parentHeaderRequestId
```
LLM HTTP Response (x-request-id header)
  → toolCallingLoop.ts (stored as lastHeaderRequestId)
    → IBuildPromptContext (via createPromptContext())
      → searchSubagentTool.ts / executionSubagentTool.ts (read from _inputContext)
        → searchSubagentToolCallingLoop.ts / executionSubagentToolCallingLoop.ts (passed in options)
          → chatStream.ts sendModelCallTelemetry() (emitted in model.modelCall.* events)
```
