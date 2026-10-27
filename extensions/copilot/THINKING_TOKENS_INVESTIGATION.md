# Thinking Tokens Telemetry Investigation — Current State

## Purpose

Verify the findings from `THINKING_TOKENS_PRIOR_INVESTIGATION.md` against the current codebase and propose a solution to ensure thinking/reasoning content from all model families appears in assistant telemetry messages.

---

## 1. Data Structures (Unchanged)

The core types remain as documented:

| Type | File | Purpose |
|------|------|---------|
| `ThinkingDelta` | `src/platform/thinking/common/thinking.ts` | Normalized streaming delta: `text`, `id`, `metadata` |
| `EncryptedThinkingDelta` | same | Opaque encrypted blob: `id`, `encrypted` |
| `ThinkingData` | same | Full record: `id`, `text`, `metadata?`, `tokens?`, `encrypted?` |
| `ThinkingDataInMessage` | same | Fields on `CAPIChatMessage`: `cot_id`, `cot_summary`, `reasoning_opaque`, `reasoning_text` |
| `ThinkingDataContainer` | `src/platform/endpoint/common/thinkingDataContainer.tsx` | TSX prompt element embedding `ThinkingData` as opaque content part |
| `CustomDataPartMimeTypes.ThinkingData` | `src/platform/endpoint/common/endpointTypes.ts` | MIME type = `'thinking'` |

Provider field mappings remain:
- **Azure OpenAI / BYOK**: `cot_id` / `cot_summary`
- **Copilot API**: `reasoning_opaque` / `reasoning_text`
- **Anthropic**: `thinking` block / `signature` (native format)

---

## 2. Three API Paths and Their Thinking Token Telemetry Status

### 2a. CAPI Path (Copilot API — GPT-4o and similar via `CopilotChatEndpoint`)

**Status: WORKING for input messages, NOT working for output messages**

**How it works:**
1. `CopilotChatEndpoint.getCompletionsCallback()` returns a callback that sets `reasoning_opaque` and `reasoning_text` on `CAPIChatMessage` (`copilotChatEndpoint.ts:53-61`)
2. `createCapiRequestBody()` calls `rawMessageToCAPI(messages, callback)` — the only production call site that passes a callback (`networking.ts:330`)
3. The resulting `request.messages` (type `CAPIChatMessage[]`) has thinking data set on assistant messages
4. In `chatMLFetcher.ts` finally blocks, `request.messages` is passed directly to `sendEngineMessagesTelemetry` — thinking fields are serialized into `engine.messages` and `model.message.added`

**Gap:** Output messages from `prepareChatCompletionForReturn` (`chatStream.ts:502-556`) build a `Raw.ChatMessage` with text-only content (no thinking), then call `rawMessageToCAPI` without a callback. The output assistant message in telemetry has no thinking data.

### 2b. Responses API Path (GPT-5.4, o-series, GPT-4.1)

**Status: NOT WORKING — two independent breaks in telemetry chain**

**Break 1 — `extractThinkingData` discards summary text (`responsesApi.ts:325-341`):**
```typescript
return {
    type: 'reasoning',
    id: thinkingData.id,
    summary: [],                    // <-- thinkingData.text DISCARDED
    encrypted_content: thinkingData.encrypted,
};
```
When building the Responses API request body, `extractThinkingData` converts `ThinkingData` (which has `text` from a prior turn's thinking summary) to `ResponseReasoningItem` but sets `summary: []`, losing the text content.

**Break 2 — `responseApiInputToRawMessagesForLogging` converts thinking to plain text (`responsesApi.ts:~457`):**
```typescript
case 'reasoning':
    messages.push({
        role: Raw.ChatRole.Assistant,
        content: [{
            type: Raw.ChatCompletionContentPartKind.Text,    // <-- Text, not Opaque
            text: `Reasoning summary: ${item.summary.map(s => s.text).join('\n\n')}`
        }]
    });
```
The logging function converts reasoning items to plain `Text` parts instead of `Opaque` parts. Combined with Break 1 (empty summary), this produces `"Reasoning summary: "` (empty). Even if summary were populated, this is `Text` type so `rawMessageToCAPI` would never treat it as thinking data.

**Break 3 — `rawMessageToCAPI` without callback drops thinking (`openai.ts:191-197`):**
```typescript
const data = rawPartAsThinkingData(content);
if (callback && data) {           // <-- callback is never passed for telemetry
    callback(out, data);
}
```
All telemetry call sites call `rawMessageToCAPI` without a callback. Even if reasoning were properly preserved as Opaque parts, thinking data would be silently dropped because no callback is provided.

**Result:** For Responses API models, `engine.messages` and `model.message.added` telemetry events have **no thinking content** in input messages. Only `"Reasoning summary: "` (empty plain text) appears.

### 2c. Anthropic/Messages API Path (Claude 3.5, Claude 4)

**Status: PARTIALLY WORKING — native format preserved in input, not in output**

**How it works:**
1. `rawContentToAnthropicContent` (`messagesApi.ts:446-470`) converts `ThinkingDataContainer` opaque parts directly to Anthropic native `thinking`/`redacted_thinking` blocks
2. `createMessagesRequestBody` returns `MessageParam[]` (Anthropic format) in `body.messages`
3. In `chatMLFetcher.ts` finally blocks, `request.messages` is `MessageParam[]`, NOT `CAPIChatMessage[]` — serialized as-is into telemetry

**What reaches telemetry:**
- Input messages have Anthropic native `thinking`/`redacted_thinking` blocks — thinking text IS present
- BUT format is Anthropic-specific (`{ type: 'thinking', thinking: '...', signature: '...' }`) not the CAPI format (`reasoning_opaque`/`reasoning_text`)

**Gap:** Output messages are text-only — thinking content from the current turn is not included in output telemetry. Anthropic also hardcodes `reasoning_tokens: 0` because the API doesn't provide token breakdown.

---

## 3. Output Thinking Content — Missing for ALL Paths

When the model response completes, the output `CAPIChatMessage` is built from `prepareChatCompletionForReturn` (`chatStream.ts:502-556`) or the equivalent in `messagesApi.ts`/`responsesApi.ts`:

```typescript
// chatStream.ts — output message construction
const message: Raw.ChatMessage = {
    role: Raw.ChatRole.Assistant,
    content: toTextParts(messageContent),   // text-only, no thinking
};
const telemetryMessage = rawMessageToCAPI(message);  // no callback
```

**Result:** The assistant's response in output telemetry never includes thinking content from the current turn, regardless of API path. Only input messages (multi-turn context from prior turns) can contain thinking.

**The thinking content for the current response IS captured** in the local OTel span attribute `copilot_chat.reasoning_content` (`chatMLFetcher.ts:432-442`), but this never reaches GH/MSFT production telemetry.

---

## 4. `engine.messages.length` Thinking Field Leak (Confirmed)

The `sendEngineMessagesLengthTelemetry` function (`chatStream.ts:32-67`) uses:
```typescript
const processedMsg: any = {
    ...msg,     // spreads ALL fields including reasoning_text, cot_summary
    content: /* replaced with length */,
};
```

Only `content` and `tool_calls[].function.arguments` are replaced by length. Top-level fields like `reasoning_text` and `cot_summary` pass through verbatim. This means:
- For the **CAPI path** (where these fields ARE set): actual thinking text appears un-redacted in `engine.messages.length`
- For the **Responses API path**: irrelevant (fields are never set)
- For the **Anthropic path**: the native `thinking`/`redacted_thinking` blocks are inside the `content` array which IS length-replaced, so they are NOT leaked

---

## 5. Summary: Prior Investigation Accuracy

| Claim | Status |
|-------|--------|
| Reasoning token counts reach GH+MSFT telemetry | ✅ Confirmed — `response.success` measurement `reasoningTokens` |
| Output thinking text never reaches GH/MSFT | ✅ Confirmed — only in local OTel `copilot_chat.reasoning_content` |
| Input thinking in multi-turn reaches telemetry (CAPI path) | ✅ Confirmed — `reasoning_opaque`/`reasoning_text` on `CAPIChatMessage` |
| `engine.messages.length` leaks thinking fields | ✅ Confirmed — `...msg` spread preserves `reasoning_text`/`cot_summary` |
| `extractThinkingData` sets `summary: []` | ✅ Confirmed — NOT fixed despite prior doc claiming it was "Changed" |
| `rawMessageToCAPI` without callback drops thinking | ✅ Confirmed — NOT fixed despite prior doc claiming it was "Changed" |
| `responseApiInputToRawMessagesForLogging` uses Text not Opaque | ✅ Confirmed — NOT fixed despite prior doc claiming it was "Changed" |
| Anthropic hardcodes `reasoning_tokens: 0` | ✅ Confirmed |

**Key discrepancy:** The prior investigation document describes three fixes as having been "Changed" (sections "Changes Made" 1-3), but **the current code does NOT reflect any of these changes**. Either the changes were reverted, never merged, or applied to a different branch.

---

## 6. Proposed Solution

### Goal
Ensure thinking/reasoning content from all model families (Responses API, CAPI, Anthropic) appears in `model.message.added` and `engine.messages` telemetry events for both input and output assistant messages.

### Fix 1: `extractThinkingData` — Populate `summary` from `thinkingData.text`

**File:** `src/platform/endpoint/node/responsesApi.ts` (~line 325)

```typescript
// BEFORE
summary: [],

// AFTER
summary: thinkingData.text
    ? (Array.isArray(thinkingData.text)
        ? thinkingData.text.map(t => ({ type: 'summary_text' as const, text: t }))
        : [{ type: 'summary_text' as const, text: thinkingData.text }])
    : [],
```

**Impact:** The Responses API request body will round-trip thinking summaries, AND `responseApiInputToRawMessagesForLogging` will produce non-empty `"Reasoning summary: ..."` text.

### Fix 2: `responseApiInputToRawMessagesForLogging` — Emit Opaque parts instead of Text

**File:** `src/platform/endpoint/node/responsesApi.ts` (~line 457)

```typescript
// BEFORE
case 'reasoning':
    messages.push({
        role: Raw.ChatRole.Assistant,
        content: [{
            type: Raw.ChatCompletionContentPartKind.Text,
            text: `Reasoning summary: ${item.summary.map(s => s.text).join('\n\n')}`
        }]
    });

// AFTER
case 'reasoning':
    flushPendingFunctionCalls();
    messages.push({
        role: Raw.ChatRole.Assistant,
        content: [{
            type: Raw.ChatCompletionContentPartKind.Opaque,
            value: {
                type: CustomDataPartMimeTypes.ThinkingData,
                thinking: {
                    id: item.id,
                    text: item.summary.map(s => s.text),
                    encrypted: item.encrypted_content,
                }
            }
        } as Raw.ChatCompletionContentPartOpaque]
    });
```

**Impact:** When `rawMessageToCAPI` processes these messages, it can extract `ThinkingData` via `rawPartAsThinkingData`.

### Fix 3: `rawMessageToCAPI` — Set thinking fields without requiring a callback

**File:** `src/platform/networking/common/openai.ts` (~line 191)

```typescript
// BEFORE
if (callback && data) {
    callback(out, data);
}

// AFTER
if (data) {
    if (callback) {
        callback(out, data);
    } else {
        // Default behavior for telemetry path: set CAPI fields directly
        out.reasoning_opaque = data.id;
        out.reasoning_text = Array.isArray(data.text) ? data.text.join('') : data.text;
    }
}
```

**Impact:** All telemetry call sites (which never pass a callback) will now get thinking data on the `CAPIChatMessage`. This fixes both the Responses API path and any other path that has Opaque thinking parts.

### Fix 4: Include thinking in output assistant messages

**File:** `src/platform/networking/node/chatStream.ts` — `prepareChatCompletionForReturn` (~line 520)

After building the output `Raw.ChatMessage`, attach thinking data from the `FetchStreamRecorder.deltas`:

```typescript
// After building the text-only message, add thinking data as Opaque part
const thinkingDeltas = c.deltas?.filter(d => d.thinking) ?? [];
if (thinkingDeltas.length > 0) {
    const thinkingTexts: string[] = [];
    let thinkingId: string | undefined;
    let thinkingEncrypted: string | undefined;
    for (const delta of thinkingDeltas) {
        if (!delta.thinking) continue;
        if ('encrypted' in delta.thinking && delta.thinking.encrypted) {
            thinkingEncrypted = delta.thinking.encrypted;
        }
        if (!isEncryptedThinkingDelta(delta.thinking) && delta.thinking.text) {
            thinkingId = delta.thinking.id;
            const text = Array.isArray(delta.thinking.text) ? delta.thinking.text.join('') : delta.thinking.text;
            if (text) thinkingTexts.push(text);
        }
    }
    if (thinkingId || thinkingEncrypted) {
        message.content.push({
            type: Raw.ChatCompletionContentPartKind.Opaque,
            value: {
                type: CustomDataPartMimeTypes.ThinkingData,
                thinking: {
                    id: thinkingId ?? '',
                    text: thinkingTexts.join(''),
                    encrypted: thinkingEncrypted,
                }
            }
        } as Raw.ChatCompletionContentPartOpaque);
    }
}
```

**Impact:** Output telemetry for ALL paths will include thinking content. With Fix 3, `rawMessageToCAPI` will set `reasoning_opaque`/`reasoning_text` on the output `CAPIChatMessage`.

**Alternative for Fix 4:** If embedding thinking into the Raw message is too invasive, set fields directly on the `CAPIChatMessage` after `rawMessageToCAPI`:
```typescript
const telemetryMessage = rawMessageToCAPI(message) as CAPIChatMessage;
if (thinkingId || thinkingEncrypted) {
    telemetryMessage.reasoning_opaque = thinkingId ?? thinkingEncrypted;
    telemetryMessage.reasoning_text = thinkingTexts.join('');
}
```

### Fix 5: Sanitize `engine.messages.length` — Strip thinking fields

**File:** `src/platform/networking/node/chatStream.ts` — `sendEngineMessagesLengthTelemetry` (~line 32)

```typescript
const processedMsg: any = {
    ...msg,
    content: /* ... */,
};
// Remove thinking text fields from length-only event
delete processedMsg.reasoning_text;
delete processedMsg.cot_summary;
```

**Impact:** Prevents thinking text from leaking through the length-sanitized event while keeping `reasoning_opaque`/`cot_id` (opaque identifiers) intact.

### Fix 6 (Optional): Anthropic output thinking in telemetry

**File:** `src/platform/endpoint/node/messagesApi.ts` — In `AnthropicMessagesProcessor`, when building the completion message, include accumulated thinking from `thinkingAccumulator`:

This may not be needed if Fix 4 handles it at the `prepareChatCompletionForReturn` level. But if the Anthropic path bypasses that function, the thinking accumulator results should be embedded in the output message similarly.

---

## 7. Impact Matrix After All Fixes

| Data | `engine.messages` (GH) | `model.message.added` (MSFT) | `engine.messages.length` | OTel (local) |
|------|------------------------|-------------------------------|--------------------------|--------------|
| **Input thinking (CAPI)** | ✅ (already works) | ✅ (already works) | ✅ Sanitized (Fix 5) | ✅ |
| **Input thinking (Responses API)** | ✅ (Fix 1+2+3) | ✅ (Fix 1+2+3) | ✅ Sanitized (Fix 5) | ✅ |
| **Input thinking (Anthropic)** | ✅ (already works, native format) | ✅ (native format) | ✅ (already sanitized via content length) | ✅ |
| **Output thinking (all paths)** | ✅ (Fix 4) | ✅ (Fix 4) | ✅ Sanitized (Fix 5) | ✅ (already works) |
| **Token count** | N/A | N/A | N/A | ✅ (already works) |

---

## 8. Implementation Priority

1. **Fix 3** (`rawMessageToCAPI` default thinking) — Simplest change, unblocks telemetry for all paths that already have Opaque thinking parts
2. **Fix 2** (`responseApiInputToRawMessagesForLogging` → Opaque) — Combined with Fix 3, enables Responses API input telemetry
3. **Fix 1** (`extractThinkingData` summary population) — Fixes the round-trip of thinking text in the actual request body AND the telemetry path
4. **Fix 5** (`engine.messages.length` sanitization) — Privacy fix, should be done alongside or before enabling more thinking in telemetry
5. **Fix 4** (output thinking in telemetry) — Adds thinking to output messages
6. **Fix 6** (Anthropic output) — Only if needed

Fixes 1-3 together form the minimal set to get Responses API thinking into telemetry. Fix 5 should accompany any change that adds more thinking text to telemetry events.

---

## 9. Implementation Status

All fixes from the proposed solution have been implemented. Here is a summary of changes per file:

### `src/platform/endpoint/node/responsesApi.ts`
- **Fix 1 — `extractThinkingData`**: Changed `summary: []` to populate from `thinkingData.text`. Now round-trips thinking summaries in the Responses API request body.
- **Fix 2 — `responseApiInputToRawMessagesForLogging`**: Changed `case 'reasoning':` from emitting `ChatCompletionContentPartKind.Text` (plain text `"Reasoning summary: ..."`) to `ChatCompletionContentPartKind.Opaque` with `CustomDataPartMimeTypes.ThinkingData`, preserving `id`, `text`, and `encrypted` fields. Added `CustomDataPartMimeTypes` import.
- **Fix 4 (Responses API output)**: Modified the `response.completed` message construction in `OpenAIResponsesProcessor.push()` to include reasoning items from `normalizedOutput` as Opaque `ThinkingData` parts. With Fix 3, `rawMessageToCAPI` automatically sets `reasoning_opaque`/`reasoning_text` on the output `CAPIChatMessage`.

### `src/platform/networking/common/openai.ts`
- **Fix 3 — `rawMessageToCAPI`**: Changed `if (callback && data)` to `if (data)` and added an `else` branch that sets `out.reasoning_opaque = data.id` and `out.reasoning_text` directly when no callback is provided. All telemetry paths now get thinking data on `CAPIChatMessage`.

### `src/platform/networking/node/chatStream.ts`
- **Fix 5 — `sendEngineMessagesLengthTelemetry`**: Added `delete processedMsg.reasoning_text` and `delete processedMsg.cot_summary` after the `...msg` spread. Prevents thinking text from leaking in the length-sanitized event while keeping opaque identifiers.
- **Debug logs**: Added `[THINKING-TELEMETRY]` info logs in `sendEngineMessagesTelemetry` that mirror what `engine.messages` and `model.message.added` send for each assistant message. Logs thinking fields (`reasoning_text`, `reasoning_opaque`, `cot_summary`, `cot_id`) separately when present, and the full serialized `CAPIChatMessage` (truncated to 2000 chars).

### `src/platform/endpoint/node/messagesApi.ts`
- **Fix 4 (Anthropic output)**: Modified the `message_stop` message construction in `AnthropicMessagesProcessor.push()` to include accumulated thinking blocks from `thinkingAccumulator` as Opaque `ThinkingData` parts. Each entry includes `id`, `text` (accumulated thinking text), and `encrypted` (signature). Added `CustomDataPartMimeTypes` import.

### Debug Log Format
The `[THINKING-TELEMETRY]` logs appear in the Copilot Log output channel at Info level:
```
[THINKING-TELEMETRY] input assistant message thinking fields: {"reasoning_text":"...", "reasoning_opaque":"..."}
[THINKING-TELEMETRY] input assistant message (model.message.added): {"role":"assistant","content":"...","reasoning_text":"...", ...}
[THINKING-TELEMETRY] output assistant message thinking fields: {"reasoning_text":"...", "reasoning_opaque":"..."}
[THINKING-TELEMETRY] output assistant message (model.message.added): {"role":"assistant","content":"...","reasoning_text":"...", ...}
```
