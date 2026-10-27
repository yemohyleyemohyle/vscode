# Telemetry Enrichment: Subagent Linking & Model Call Tracking

## Goal

Enrich the `response.success` telemetry event with fields that enable linking subagent model calls back to their parent, and tracking iteration position within tool-calling loops. Also surface `modelCallId` from the fetcher so it can be used for precise parent-child linking.

## Diff Hunk-by-Hunk Explanation (12 files, +143/-17 vs main)

---

### File 1: `extensions/copilot/src/extension/intents/node/toolCallingLoop.ts` (+11/-5)

**Hunk 1 — `ToolCallingLoopFetchOptions` type (line 107)**
```diff
-export type ToolCallingLoopFetchOptions = ... & Pick<IMakeChatRequestOptions, 'modelCapabilities' | 'summarizedAtRoundId'>;
+export type ToolCallingLoopFetchOptions = ... & Pick<IMakeChatRequestOptions, 'modelCapabilities' | 'summarizedAtRoundId'> & { iterationNumber: number };
```
Extends the options that the base `ToolCallingLoop` passes to each `fetch()` override with `iterationNumber`. This is the 0-based loop iteration counter from `runOne()`. Every subclass (`DefaultToolCallingLoop`, `ExecutionSubagentToolCallingLoop`, `SearchSubagentToolCallingLoop`) now receives this value and can include it in telemetry.

**Hunk 2 — New `lastModelCallId` field (line 180)**
```diff
 	private lastHeaderRequestId: string | undefined;
+	private lastModelCallId: string | undefined;
```
Adds a companion field to `lastHeaderRequestId`. After each successful fetch, stores the `modelCallId` returned from the fetcher. This value becomes `parentModelCallId` for any subagent spawned in subsequent tool calls.

**Hunk 3 — Pass `parentModelCallId` in `createPromptContext()` (line 275)**
```diff
 			parentHeaderRequestId: this.lastHeaderRequestId,
+			parentModelCallId: this.lastModelCallId,
```
Includes `parentModelCallId` in the `IBuildPromptContext` created for subagent tools. This context is injected into tool instances, which read it when creating subagent loops.

**Hunk 4 — Pass `iterationNumber` in fetch options (line 1382)**
```diff
 			userInitiatedRequest: ...,
+			iterationNumber,
 			modelCapabilities: {
```
Passes the current loop iteration number into the fetch options object. The `iterationNumber` variable comes from the `for` loop counter in `runOne()`.

**Hunk 5 — Switch to `serverRequestId` and capture `modelCallId` (lines 1388–1400)**
```diff
-		// Store the headerRequestId from the fetch response for subagent telemetry linking.
-		// Use requestId (the client-generated UUID sent as X-Request-Id header), not serverRequestId
-		// (the server's response header value), because requestId is what appears as headerRequestId
-		// across all telemetry events.
+		// Store the server-echoed headerRequestId from the fetch response for subagent telemetry linking.
+		// Prefer serverRequestId (the server's x-request-id response header) because it matches
+		// chatCompletion.requestId.headerRequestId which is reported as `requestId` in response.success.
+		// Fall back to requestId (client-generated UUID) if the server didn't echo the header.
 		if (fetchResult.type === ChatFetchResponseType.Success) {
-			this.lastHeaderRequestId = fetchResult.requestId;
+			this.lastHeaderRequestId = fetchResult.serverRequestId ?? fetchResult.requestId;
+			this.lastModelCallId = fetchResult.modelCallId;
 		}
```
Two changes:
1. **`serverRequestId` preference**: The `response.success` event reports `requestId` as `chatCompletion.requestId.headerRequestId` — the server-echoed value. Previously we stored the client-generated UUID (`fetchResult.requestId`), which might differ if the server doesn't echo it back. Now we prefer `serverRequestId` so `child.parentRequestId = parent.requestId` is a guaranteed match.
2. **Capture `modelCallId`**: Stores the newly-surfaced `modelCallId` from the fetch result for parent linking.

---

### File 2: `extensions/copilot/src/extension/prompt/common/intents.ts` (+5)

**Hunk 1 — Add `parentModelCallId` to `IBuildPromptContext` (line 128)**
```diff
 	readonly parentHeaderRequestId?: string;
+	/**
+	 * The modelCallId from the most recent parent model call.
+	 * Used by subagent tools to link their telemetry back to the parent's specific model call.
+	 */
+	readonly parentModelCallId?: string;
```
Adds the `parentModelCallId` property to the build-prompt context interface. This is the contract between the tool-calling loop (which sets it) and the tool implementations (which read it). Mirrors the existing `parentHeaderRequestId` pattern.

---

### File 3: `extensions/copilot/src/extension/prompt/node/chatMLFetcher.ts` (+15/-6)

This file has 9 hunks, all serving one purpose: **thread `modelCallId` out of the fetcher's internal methods so it reaches callers.**

**Hunk 1 — New `actualModelCallId` variable in `fetchMany` (line 204)**
```diff
 		let resumeEventSeen: boolean | undefined;
+		let actualModelCallId: string | undefined;
```
Declares a variable to hold the `modelCallId` extracted from the inner fetch result, parallel to existing `actualStatusCode`, `suspendEventSeen`, etc.

**Hunk 2 — Extract `modelCallId` from fetch result (line 250)**
```diff
 				resumeEventSeen = fetchResult.resumeEventSeen;
+				actualModelCallId = fetchResult.modelCallId;
```
Captures `modelCallId` from the HTTP/WebSocket fetch result alongside other metadata.

**Hunk 3 — Pass `actualModelCallId` to `processSuccessfulResponse` (line 315)**
```diff
-					const result = await this.processSuccessfulResponse(response, ..., suspendEventSeen, resumeEventSeen);
+					const result = await this.processSuccessfulResponse(response, ..., suspendEventSeen, resumeEventSeen, actualModelCallId);
```
Passes the captured `modelCallId` into the success processing method.

**Hunks 4–6 — Return type extensions (lines 859, 936, 1067)**
```diff
-	): Promise<{ result: ...; otelSpan?: ISpanHandle }> {
+	): Promise<{ result: ...; otelSpan?: ISpanHandle; modelCallId?: string }> {
```
Three internal methods (`_fetchAndStreamChat`, `fetchAndStreamViaWebSocket`, `_doFetchAndStreamChat`) have their return types extended with `modelCallId?: string`. This is pure plumbing — the value flows up through the call chain.

**Hunk 7 — Return `modelCallId` from Response API path (line 1229)**
```diff
 			result: {
 				type: FetchResponseKind.Success,
 				chatCompletions,
-			}
+			},
+			modelCallId,
```
The Responses API code path (`_doFetchAndStreamChat`) now includes `modelCallId` in its return object.

**Hunk 8 — Return type + value for HTTP path (lines 1249, 1347)**
```diff
-	): Promise<{ result: ...; statusCode?: number }> {
+	): Promise<{ result: ...; statusCode?: number; modelCallId?: string }> {
```
and:
```diff
 			fetcher: response.fetcher,
-			bytesReceived: response.bytesReceived
+			bytesReceived: response.bytesReceived,
+			modelCallId,
```
The HTTP fetch path (`_doFetchViaHttp`) generates `modelCallId = generateUuid()` and now returns it alongside the response.

**Hunk 9 — `processSuccessfulResponse` accepts and propagates `modelCallId` (lines 1739, 1763, 1781)**
```diff
 		resumeEventSeen: boolean | undefined,
+		modelCallId: string | undefined,
```
New parameter. Then used in two places:
1. Passed to `Telemetry.sendSuccessTelemetry(...)` via `IChatMLFetcherSuccessfulData`.
2. Included in the returned `FetchSuccess` object so `toolCallingLoop` can read it.

---

### File 4: `extensions/copilot/src/extension/prompt/node/chatMLFetcherTelemetry.ts` (+68/-1)

**Hunk 1 — Add `modelCallId` to `IChatMLFetcherSuccessfulData` (line 31)**
```diff
 	resumeEventSeen: boolean | undefined;
+	modelCallId: string | undefined;
```
The data interface for success telemetry now carries `modelCallId`, allowing the telemetry sender to include it in the event.

**Hunk 2 — Destructure `modelCallId` (line 103)**
```diff
 			resumeEventSeen,
+			modelCallId,
 		}: IChatMLFetcherSuccessfulData,
```
Destructures the new field from the data parameter.

**Hunk 3 — GDPR annotations for 5 new fields (lines 149–156)**
```diff
-				"resumeEventSeen": { ... }
+				"resumeEventSeen": { ... },
+				"subType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Sub-type of the request" },
+				"modelCallId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Unique identifier for this model call" },
+				"parentRequestId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "The requestId from the parent response.success event for subagent calls" },
+				"parentModelCallId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Model call ID of the parent request for subagent calls" },
+				"iterationNumber": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Iteration number within the tool calling loop" }
```
GDPR compliance annotations for each new field. Required by the VS Code telemetry pipeline — without these, the fields would be stripped.

**Hunk 4 — Add 5 new fields to `sendTelemetryEvent` call (lines 171–176)**
```diff
 			reasoningSummary: requestBody.reasoning?.summary,
+			modelCallId,
+			...(baseTelemetry?.properties.subType ? { subType: baseTelemetry.properties.subType } : {}),
+			...(baseTelemetry?.properties.parentHeaderRequestId ? { parentRequestId: baseTelemetry.properties.parentHeaderRequestId } : {}),
+			...(baseTelemetry?.properties.parentModelCallId ? { parentModelCallId: baseTelemetry.properties.parentModelCallId } : {}),
+			...(baseTelemetry?.properties.iterationNumber ? { iterationNumber: baseTelemetry.properties.iterationNumber } : {}),
```
The actual telemetry emission. Key design decisions:
- `modelCallId` is always included (it's always defined for successful requests).
- `subType`, `parentRequestId`, `parentModelCallId`, `iterationNumber` are conditionally spread — only present for subagent requests.
- `parentRequestId` reads from `baseTelemetry.properties.parentHeaderRequestId` (the internal plumbing name) but emits as `parentRequestId` (matching the `requestId` field name in the same event for join consistency).

**Hunk 5 — Debug logging block (lines 205–263)**
```diff
+		// >>> DEBUG: log response.success telemetry payload — REMOVE THIS BLOCK <<<
+		{ ... console.log(...) ... }
+		// >>> END DEBUG BLOCK <<<
```
Temporary debug block that logs the full `response.success` properties and measurements to console. Includes all new fields plus `requestId` source tracing. To be removed after investigation concludes.

---

### File 5: `extensions/copilot/src/extension/prompt/node/defaultIntentRequestHandler.ts` (+1)

**Hunk 1 — Add `iterationNumber` to telemetry properties (line 732)**
```diff
 				parentRequestId: this.options.request.parentRequestId,
+				iterationNumber: opts.iterationNumber.toString(),
```
The default (main agent) tool-calling loop override now includes `iterationNumber` in the `telemetryProperties` it passes to the fetcher. Converts from number to string because `IChatRequestTelemetryProperties` types all properties as strings. This is the entry point for `iterationNumber` into `baseTelemetry.properties`.

---

### File 6: `extensions/copilot/src/extension/prompt/node/executionSubagentToolCallingLoop.ts` (+4/-1)

**Hunk 1 — Add `parentModelCallId` to options interface (line 42)**
```diff
 	parentHeaderRequestId?: string;
+	/** The modelCallId from the parent agent's model call that triggered this subagent invocation. */
+	parentModelCallId?: string;
```
Extends the execution subagent loop options with `parentModelCallId` so it can be passed from the tool.

**Hunk 2 — Destructure `iterationNumber` in `fetch()` (line 147)**
```diff
-	protected async fetch({ messages, finishedCb, requestOptions, modelCapabilities }: ToolCallingLoopFetchOptions, ...
+	protected async fetch({ messages, finishedCb, requestOptions, modelCapabilities, iterationNumber }: ToolCallingLoopFetchOptions, ...
```
Now destructures `iterationNumber` from the fetch options (added to the type in file 1, hunk 1).

**Hunk 3 — Include new fields in telemetry properties (line 169)**
```diff
 				parentHeaderRequestId: this.options.parentHeaderRequestId,
+				parentModelCallId: this.options.parentModelCallId,
+				iterationNumber: iterationNumber.toString(),
```
Passes both `parentModelCallId` and `iterationNumber` into the subagent's `telemetryProperties`, which flow into `baseTelemetry` and ultimately into `response.success`.

---

### File 7: `extensions/copilot/src/extension/prompt/node/searchSubagentToolCallingLoop.ts` (+4/-1)

Identical changes to file 6, for the search subagent loop. Same 3 hunks: options interface, `fetch()` destructuring, telemetry properties.

---

### File 8: `extensions/copilot/src/extension/tools/node/executionSubagentTool.ts` (+1)

**Hunk 1 — Pass `parentModelCallId` to loop options (line 72)**
```diff
 			parentHeaderRequestId: this._inputContext?.parentHeaderRequestId,
+			parentModelCallId: this._inputContext?.parentModelCallId,
```
Reads `parentModelCallId` from `_inputContext` (set by `IBuildPromptContext` in `createPromptContext()`) and passes it to the `ExecutionSubagentToolCallingLoop` constructor options.

---

### File 9: `extensions/copilot/src/extension/tools/node/searchSubagentTool.ts` (+1)

Identical to file 8, for the search subagent tool.

---

### File 10: `extensions/copilot/src/platform/chat/common/commonTypes.ts` (+1/-1)

**Hunk 1 — Add `modelCallId` to `FetchSuccess<T>` (line 193)**
```diff
-	{ type: ChatFetchResponseType.Success; value: T; requestId: string; serverRequestId: string | undefined; ... };
+	{ type: ChatFetchResponseType.Success; value: T; requestId: string; serverRequestId: string | undefined; ...; modelCallId?: string };
```
The shared `FetchSuccess<T>` type now includes `modelCallId`. This is the type that `toolCallingLoop` reads from after each fetch. Without this, `fetchResult.modelCallId` wouldn't type-check.

---

### File 11: `extensions/copilot/src/platform/networking/common/networking.ts` (+4)

**Hunk 1 — Add `parentModelCallId` and `iterationNumber` to `IChatRequestTelemetryProperties` (line 236)**
```diff
 	parentHeaderRequestId?: string;
+	/** For a subagent: The modelCallId from the parent agent's model call that triggered this subagent invocation. */
+	parentModelCallId?: string;
+	/** The 0-based iteration number of the tool-calling loop that produced this request. */
+	iterationNumber?: string;
```
Extends the telemetry properties type with the two new fields. This type is used by all fetch call sites (`defaultIntentRequestHandler`, `executionSubagentToolCallingLoop`, `searchSubagentToolCallingLoop`) and flows into `baseTelemetry.properties` inside the fetcher.

---

### File 12: `extensions/copilot/src/platform/networking/node/chatStream.ts` (+27)

**Hunk 1 — Debug block for `model.request.added` (line 278)**
```diff
 	telemetryService.sendInternalMSFTTelemetryEvent('model.request.added', ...);
+	// >>> DEBUG model.request.added — REMOVE THIS BLOCK <<<
+	{ console.log(`[DEBUG] model.request.added properties:`, ...); }
+	// >>> END DEBUG model.request.added <<<
```
Temporary debug logging for the `model.request.added` MSFT-internal event.

**Hunk 2 — Add `parentModelCallId` and `iterationNumber` to `model.modelCall.input/output` (lines 403–426)**
```diff
+			const parentModelCallId = telemetryData.properties.parentModelCallId;
 			const modelCallData = TelemetryData.createAndMarkAsIssued({
 				...
+				...(telemetryData.properties.iterationNumber && { iterationNumber: telemetryData.properties.iterationNumber }),
 				...(parentToolCallId && { parentToolCallId }),
 				...(parentHeaderRequestId && { parentHeaderRequestId }),
+				...(parentModelCallId && { parentModelCallId }),
 			}, telemetryData.measurements);
 			telemetryService.sendInternalMSFTTelemetryEvent(eventName, ...);
+			// >>> DEBUG model.modelCall.input/output — REMOVE THIS BLOCK <<<
+			{ console.log(`[DEBUG] ${eventName} properties:`, ...); }
+			// >>> END DEBUG model.modelCall.input/output <<<
```
Three changes in `sendModelCallTelemetry()`:
1. Extracts `parentModelCallId` from the telemetry data.
2. Includes `iterationNumber` and `parentModelCallId` in the `model.modelCall.input/output` events.
3. Temporary debug logging block.

**Hunk 3 — Debug block for `engine.messages` (line 476)**
```diff
+	// >>> DEBUG engine.messages — REMOVE THIS BLOCK <<<
+	{ console.log(`[DEBUG] engine.messages (${_dir}) properties:`, ...); }
+	// >>> END DEBUG engine.messages <<<
```
Temporary debug logging for the `engine.messages` event.

---

## Background

### Existing Infrastructure (already in `main`)
- `parentHeaderRequestId` — already plumbed through `IBuildPromptContext`, `toolCallingLoop.lastHeaderRequestId`, subagent tools, subagent loops, and `IChatRequestTelemetryProperties`. Also already emitted in `model.modelCall.input/output` events.
- `parentRequestId` (VS Code chat turn ID) — already plumbed from the VS Code extension host (`runSubagentTool.ts` → `ChatRequest.parentRequestId`) through `defaultIntentRequestHandler.ts` into `IChatRequestTelemetryProperties`.
- `parentToolCallId` — already in `IChatRequestTelemetryProperties` and `model.modelCall.input/output` events.

### What Was Missing
1. **`modelCallId`** was generated per HTTP request inside `chatMLFetcher.ts` but never surfaced to callers — trapped inside the fetcher.
2. **`parentModelCallId`** didn't exist — no way to link a subagent's calls to the *specific* parent model call.
3. **`iterationNumber`** — no field tracking which tool-calling loop iteration produced each request.
4. **`response.success`** lacked `modelCallId`, `parentRequestId`, `parentModelCallId`, `subType`, and `iterationNumber`.

## Changes Made

### 1. Surface `modelCallId` from the Fetcher (12 files, +143/-17 vs main)

**`commonTypes.ts`** — Added `modelCallId?: string` to `FetchSuccess<T>`.

**`chatMLFetcher.ts`** (21 lines) — Threaded `modelCallId` through the full internal fetch chain:
- `_doFetchViaHttp` → `_doFetchAndStreamChat` → `_fetchAndStreamChat` → `fetchMany` → `processSuccessfulResponse` — all return types extended with `modelCallId`.
- `fetchMany` extracts `actualModelCallId` from the fetch result and passes it down.
- `processSuccessfulResponse` accepts and returns `modelCallId` in `FetchSuccess`.

### 2. Capture `modelCallId` in Tool-Calling Loop & Pass as `parentModelCallId`

**`toolCallingLoop.ts`** — Added `private lastModelCallId: string | undefined`. On successful fetch, stores `fetchResult.modelCallId`. In `createPromptContext()`, passes `parentModelCallId: this.lastModelCallId`.

**`intents.ts`** — Added `readonly parentModelCallId?: string` to `IBuildPromptContext`.

**`executionSubagentTool.ts` / `searchSubagentTool.ts`** — Pass `parentModelCallId: this._inputContext?.parentModelCallId` when creating subagent loops.

**`executionSubagentToolCallingLoop.ts` / `searchSubagentToolCallingLoop.ts`** — Added `parentModelCallId?: string` to options interface. Include `parentModelCallId` in `telemetryProperties`.

### 3. Add `iterationNumber` to Track Loop Position

**`toolCallingLoop.ts`** — Extended `ToolCallingLoopFetchOptions` with `{ iterationNumber: number }`. Passed in `this.fetch()` call.

**`defaultIntentRequestHandler.ts`** — Added `iterationNumber: opts.iterationNumber.toString()` to `telemetryProperties`.

**`executionSubagentToolCallingLoop.ts` / `searchSubagentToolCallingLoop.ts`** — Destructured `iterationNumber` in `fetch()` signature, added to `telemetryProperties`.

**`networking.ts`** — Added `parentModelCallId?: string` and `iterationNumber?: string` to `IChatRequestTelemetryProperties`.

### 4. Enrich `response.success` Event

**`chatMLFetcherTelemetry.ts`** (main change) — Added to the actual `sendTelemetryEvent('response.success', ...)` call with GDPR annotations:

| Field | Source | Description |
|-------|--------|-------------|
| `modelCallId` | `IChatMLFetcherSuccessfulData.modelCallId` (surfaced from fetcher) | Unique ID for this model call. Joins to `modelCallId` in `model.modelCall.input/output`. |
| `subType` | `baseTelemetry.properties.subType` | `"subagent"` or `"system-initiated"` or absent for user requests. |
| `parentRequestId` | `baseTelemetry.properties.parentHeaderRequestId` | The `requestId` from the **parent's** `response.success` event. Enables `child.parentRequestId = parent.requestId` joins. |
| `parentModelCallId` | `baseTelemetry.properties.parentModelCallId` | The `modelCallId` from the parent's model call. Enables `child.parentModelCallId = parent.modelCallId` joins. |
| `iterationNumber` | `baseTelemetry.properties.iterationNumber` | 0-based iteration within the tool-calling loop. |

Also added `modelCallId` to `IChatMLFetcherSuccessfulData` interface.

### 5. Enrich `model.modelCall.input/output` Events

**`chatStream.ts`** — In `sendModelCallTelemetry()`: extracts `parentModelCallId` and `iterationNumber` from `telemetryData.properties` and includes them in the event payload.

### 6. Fix `parentHeaderRequestId` Source Value

**`toolCallingLoop.ts`** — Changed from `fetchResult.requestId` (client-generated UUID) to `fetchResult.serverRequestId ?? fetchResult.requestId`. This ensures `parentRequestId` in the child's `response.success` matches `requestId` (`chatCompletion.requestId.headerRequestId`) in the parent's `response.success`.

### 7. Debug Logging (temporary)

Added `>>> DEBUG ... REMOVE THIS BLOCK <<<` console.log blocks in:
- `chatMLFetcherTelemetry.ts` — full `response.success` properties + measurements
- `chatStream.ts` — `model.request.added`, `model.modelCall.input/output`, `engine.messages` properties + measurements

## Design Decisions

### `parentRequestId` naming
The event field is called `parentRequestId` (not `parentHeaderRequestId`) because it matches the `requestId` field in the same event type. Internally the plumbing still uses `parentHeaderRequestId` in `IChatRequestTelemetryProperties` and `IBuildPromptContext` since those carry the HTTP-level `headerRequestId`.

### Removed `parentToolCallId` from `response.success`
Since `response.success` never has a `toolCallId` field, having a `parentToolCallId` was misleading — it implied a parent-child relationship that couldn't be joined within this event type. `parentToolCallId` remains in `model.modelCall.input/output` events where it's meaningful.

### Removed old `parentRequestId` (VS Code chat turn ID) from `response.success`
The old `parentRequestId` was the VS Code extension host chat request turn ID (`ChatRequest.parentRequestId` from `runSubagentTool.ts`). This is a UI-level identifier that doesn't correspond to any other field in `response.success`. It's already emitted in participant telemetry events where it belongs. Removing it freed the field name for our HTTP-level parent link.

### `serverRequestId` preference for parent linking
We prefer `fetchResult.serverRequestId` (the server-echoed `x-request-id` header) over `fetchResult.requestId` (client-generated UUID) because `response.success.requestId` is set from `chatCompletion.requestId.headerRequestId` which is the server-echoed value. Using the same source guarantees join correctness.

## Data Flow

```
chatMLFetcher.ts (generates modelCallId per HTTP request)
  └─► _doFetchViaHttp → ... → fetchMany (extracts modelCallId)
        └─► processSuccessfulResponse → FetchSuccess { modelCallId, requestId, serverRequestId }

toolCallingLoop.ts (captures on success)
  ├─► lastModelCallId = fetchResult.modelCallId
  ├─► lastHeaderRequestId = fetchResult.serverRequestId ?? fetchResult.requestId
  └─► createPromptContext() { parentModelCallId, parentHeaderRequestId }
        └─► executionSubagentTool / searchSubagentTool
              └─► subagent loop options { parentModelCallId, parentHeaderRequestId }
                    └─► fetch() telemetryProperties { parentModelCallId, parentHeaderRequestId, iterationNumber }
                          ├─► chatMLFetcher baseTelemetry (carries all properties)
                          │     └─► chatMLFetcherTelemetry.ts → response.success event
                          │           { modelCallId, parentRequestId (from parentHeaderRequestId),
                          │             parentModelCallId, subType, iterationNumber }
                          └─► chatStream.ts → model.modelCall.input/output events
                                { parentModelCallId, parentHeaderRequestId, iterationNumber }
```

## Joining Events (Kusto)

```kql
// Link child response.success to parent response.success
let parent = response_success | project parentReqId = requestId, parentModelCallId = modelCallId, ...;
let child = response_success | where isnotempty(parentRequestId);
child
| join kind=inner parent on $left.parentRequestId == $right.parentReqId
// Optional: also join on parentModelCallId == parentModelCallId for exact model call linking
```

## Cleanup TODO
- Remove all `>>> DEBUG ... REMOVE THIS BLOCK <<<` blocks from `chatMLFetcherTelemetry.ts` and `chatStream.ts` after investigation concludes.
- Delete this investigation file.
