# Agent Host node tests

Choose the lowest test type that exercises the behavior:

- `*.test.ts`: in-process unit tests for one service, mapper, reducer, or provider component.
- `protocol/`: a real Agent Host server driven over AHP with `ScriptedMockAgent`. Use for server and protocol contracts that do not depend on a provider SDK.
- `e2e/providers/`: the whole server and bundled provider process with deterministic LLM captures and AHP snapshots. Use when provider behavior is part of the contract.
- `providerIntegration/`: a real provider process backed by the local mock LLM. Use when provider lifecycle matters but realistic model behavior does not.
- Other `*.integrationTest.ts` files at this level: focused component integrations that do not exercise AHP end to end, such as direct SDK or Git-service coverage.

Tests that launch a real provider process isolate its home, configuration, logs, and session state in a temporary directory.

The protocol and E2E folders contain their own running and authoring instructions.

## Copilot resume customization ownership

Client plugins and tools belong to the owning session, not the SDK storage URI. Resume must use the same owning-session active-client state as creation and send-time configuration checks, including when an `ahp-session` owner has a separate `copilotcli` backing.

The `client plugins across chat launches` suite in [copilotAgent.test.ts](./copilotAgent.test.ts) exercises imported AHP sessions, legacy imports, and fresh AHP sessions through the real provider launch path with a mocked SDK. It verifies plugin inclusion, no restarts on unchanged turns, stable backing identity, and exactly one refresh after adding a plugin. Run it alongside import/resume and customization controls after refreshing compiled output:

```bash
./scripts/test.sh --run src/vs/platform/agentHost/test/node/copilotAgent.test.ts --grep 'client plugins across chat launches|createChat exact-chat provisioning \(import\)|MCP configuration preparation|_resumeSession fallback|customization anchoring|standalone client customizations|the prepared turn awaits' --reporter dot
```

## Request-survival model metadata

Outgoing contributions receive the explicit or inherited model selection captured by the send path after selection updates. The survival logger captures that selection's identifier synchronously at the originating boundary and retains it independently of later chat model changes. `baseModel` and `observationModel` describe selections, not provider-resolved executing models; Auto/Fusion remains a selection and unresolved values stay null.

The effective-selection cases in [requestDiffSurvival.test.ts](./requestDiffSurvival.test.ts) cover character-diff records, inherited selection, explicit override, unknown values, Auto/Fusion, and later model changes. The model-selection suite in [agentSideEffects.test.ts](./agentSideEffects.test.ts) verifies that the real send path forwards those facts without changing the outgoing message.

## Request-survival experiment cadence

With `VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG=1`, `requestCharacterDiffSurvivalObservation` is the sole experimental survival record kind. Schema version 5 adds `engine` and preserves ordinary request-end observations: index 0 describes the originating request, and indices 1–10 describe the next ten eligible completed requests in the same chat. `maximumObservationCount` is 11 including the initial record; `maximumFollowUpCount` is 10. Index 10 is final and releases the tracker. Requests without available Git checkpoints do not produce ordinary observations. Success, cancellation, and non-resumable errors finalize started requests; resumable errors do not.

For a complete initial observation, the states are `(A, B, B)`, so all original additions and deletions survive. The ratio is 1 for a nonempty edit and null for no net edit. Incomplete results must not be interpreted as valid survival. Subsequent observations compare the original start/end checkpoints directly against the latest end checkpoint. Changes between requests and within the next request are therefore combined.

The original character diff remains in memory until its tracker retires or its chat/session state is evicted. The three budgets and ten-follow-up limit are centralized in [requestDiffSurvivalLimits.ts](../../node/chatContributions/requestDiffSurvival/requestDiffSurvivalLimits.ts): 512 KiB combined before/after Git blob bytes per file comparison, 4 MiB cumulative input per originating request's observation, and 16 MiB estimated retained original diffs across chats in one Agent Host process. Exactly-at-limit work is allowed. Git size metadata is checked before loading content; initial A→B input counts once, and follow-ups share one input budget across A→C and B→C, counting repeated inputs again.

Ordinary records have `status: 'measured'` and numeric zero budget flags. A violated budget emits one terminal `status: 'budgetExceeded'` record, `complete: false`, `isFinalObservation: true`, and one or more numeric flags: `fileInputBudgetExceeded`, `observationInputBudgetExceeded`, or `retainedDiffBudgetExceeded`. Every survival field, including the ratio, is -1; `diffs` is absent. Identity, model selection, cadence metadata, limits, and small `budgetDiagnostics` remain. No extra final computation occurs, and that origin is permanently retired. A zero flag does not certify a check that was never reached. Missing or invalid size metadata is an explicit incomplete calculation, not a zero-byte estimate.

Retained admission reserves synchronously across chats and rejects the new origin rather than evicting others. The conservative estimator charges 256 bytes per repository-diff container, 256 bytes per file, twice the file's combined Git input bytes for potentially retained source strings, twice the qualified path lengths, and 128 bytes plus twice the path/text lengths per change. Error entries cost 64 bytes plus twice their string length. Reservations are checked before retained file/change construction; retirement, failed construction, chat/session eviction, unregister, and host disposal release ownership. Queued work cannot revive evicted state. These are accounted bytes, not a hard JavaScript heap/RSS or machine-wide bound: diff working allocations, temporary follow-up diffs, log serialization, and garbage-collection timing are not capped by the retained counter.

Tracker lifetime limits are centralized in the same limits object: `idleExpiryMs` is 60 minutes and `maximumTrackerAgeMs` is 24 hours. Same-chat request-start/end activity resets the idle clock; idle expiry is suspended while a request runs. Typing, view focus, streaming chunks, and other chats do not extend it. Maximum age starts at the originating request-end boundary, not completion of queued observation work, and continues during active requests. A single disposable scheduler uses monotonic time and runs without another request arriving. Exactly-at-deadline expiry applies, and maximum age takes precedence when both deadlines have elapsed.

Expiry emits at most one terminal record at the next observation index with `observationBoundary: 'expiry'`, `terminalReason: 'idleExpired' | 'maximumAgeExceeded'`, and `isFinalObservation: true`. It reuses the last associated `observationRequestId` and model; no synthetic request or independent counter is created. The boundary, not the request ID, identifies expiry-triggered work. A tracker already finalized at index 10 produces no expiry record.

When safe, expiry captures fresh working-tree tree IDs with the existing Git temp-index helper and computes final A→C/B→C comparisons under the same input budgets, reusing retained A→B. Valid results remain `status: 'measured'`. A confirmed budget violation remains `status: 'budgetExceeded'` with its flags and expiry reason, without further computation. Unsafe/missing/failed capture or incomplete computation emits `status: 'unavailable'`, `complete: false`, no `diffs`, and -1 for every survival field, with `unavailableReason`: `repositoryBusy`, `repositoryActivity`, `captureFailed`, `computationFailed`, `initialObservationIncomplete`, or `observationInProgress`.

Known active turns in overlapping repositories prevent capture, including other chats; unknown active-turn directories conservatively prevent it too. Host activity observed during capture invalidates it even if the activity ended before capture completed. This is not a guarantee against external processes mutating repositories. Expiry does not wait for a quiet window or behind queued ordinary observations. A tracker with observation work already in flight receives an unavailable terminal and releases ownership immediately; its pending work cannot later emit an ordinary observation or restore retained reservations. Objects referenced by in-flight work become reclaimable when that work unwinds.

Eviction, unregister, and shutdown cancel owned scheduling and release state without requiring new Git work or a final measurement. Lifetime cutoffs are not hard execution deadlines: event-loop stalls can delay recognition, synchronous diff calls cannot be interrupted, and existing Git timeouts/cancellation still govern asynchronous work. Compute-on-demand remains deferred. Ordinary Git checkpoints and normal editor/host edit telemetry remain unchanged; expiry tree snapshots do not add persistent per-turn checkpoint refs or delete existing checkpoints.

The former `requestDiffSurvivalObservation`, `requestCharacterSurvivalSnapshot`, and `requestFocusWindowSurvivalSnapshot` streams and their exclusive collection work have been removed. No line-diff survival computation or original line-diff payload is retained. Consumers of historical logs must distinguish the old start/end cadence, schema-2 end-only measurements, schema-3 budget terminals, and schema-4 expiry boundaries. Exclude budget/unavailable and incomplete records from measured survival aggregates; analyze valid expiry measurements separately from ordinary request-end follow-ups. Expiry and budget termination censor the remaining follow-up window, rather than themselves proving survival loss.

## Request-survival compute and size events

Input protection now preflights the entire observation before any blob-content reads or character-diff calls. It enumerates changed files and reads before/after blob-size metadata for A→B at index 0, or for both A→C and B→C at follow-up/expiry. All repositories and required comparisons share the existing 4 MiB allowance; repeated inputs count again and equality remains allowed. Preflight stops as soon as a file or cumulative input violation is known, without scanning the remaining files just to calculate a full rejected total. A late oversized file, repository, or second-comparison rejection therefore prevents character work for the whole observation, not just its unprocessed suffix.

Preflight stores only file descriptors, immutable checkpoint refs, sizes, and explicit errors, never blob contents. Admitted work reuses that metadata rather than repeating size queries or charging input twice; loaded content must still match its preflight size. Missing metadata remains an explicit incomplete file result, not a zero-size estimate. Retained-output reservations still run during construction and can reject after character work has begun. The worker's cooperative timeout is not a hard CPU-time or end-to-end deadline, so under-budget difficult inputs can still be expensive.

For these builds, `observationInputBytes` is accepted/preflight-admitted input, not a claim that those bytes were loaded or character-processed. An input-rejected observation emits a compute summary with `status: 'budgetRejected'`, `startedFileCount: 0`, `cpuMeasurementStatus: 'notStarted'`, and null CPU/elapsed timings. The existing available-CPU plot intentionally omits these records; inspect unfiltered summaries and size/survival terminals to verify early rejection. Prefix builds before this change could spend CPU on accepted files before discovering the same violation. Record the implementation revision when comparing runs; event schemas and threshold values are unchanged.

The same `VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG=1` opt-in emits two additional local diagnostic event kinds: compute schema version 2 and size schema version 1.

- `[RequestCharacterDiffComputeObservation] ` / `requestCharacterDiffComputeObservation`
- `[RequestCharacterDiffSizeObservation] ` / `requestCharacterDiffSizeObservation`

They do not add product telemetry or advance the observation horizon. Every event copies `sessionId`, `chatId`, `originatingRequestId`, `observationRequestId`, and `observationIndex` from its associated survival observation/attempt, including expiry. File events add zero-based `repositoryIndex` and `fileIndex`; `comparisonKind` uses the existing diff roles: `originalRequest` (A→B), `baselineToLatest` (A→C), and `requestResultToLatest` (B→C). At index 0, C is B.

Compute events have `phase: 'file' | 'comparison' | 'observation'`. File events report monotonic `elapsedMs` and, when supported, executing-thread `cpuUserMs`, `cpuSystemMs`, and `cpuTotalMs`. CPU values are converted from microseconds to milliseconds. `cpuMeasurementStatus` is `available`, `unsupported`, `failed`, or `notStarted`; unavailable timings are null, never fabricated zero CPU. `computationStarted` distinguishes pre-dispatch rejection from an attempted call; a transport failure can leave actual worker execution unknown. Counts report started/completed/failed files and available UTF-16 output lengths/range counts. Comparison and observation timings are sums of file-call timings, not total Git/queue elapsed time or whole-pipeline CPU. Select one phase when aggregating to avoid counting the same work repeatedly.

Index-0 baseline reuse and the empty B→B comparison, and later retained-original reuse, have explicit `reused`/`empty` statuses with null timings. Comparisons not reached after failure/budget termination are `notStarted`. Worker readings finish before host materialization and event logging. CPU-read and cost-log failures produce warnings without replacing the original diff outcome. Thread CPU includes thread-local runtime/GC work, not background GC or Git subprocess CPU. No forced GC or heap/RSS sampling is added.

Size events report accepted `observationInputBytes`, known `fileInputBytes`, `trackerEstimatedRetainedBytes`, `hostEstimatedRetainedBytes`, applicable `limits`, and known `proposedObservationInputBytes`/`proposedHostEstimatedRetainedBytes` on rejection. Proposed input is not added to the accepted counter. Phases cover `inputCheck`, `fileConstruction`, `admission`, `rollback`, `budgetRejection`, `release`, and `observation`; internal change-object reservations do not each emit an event. Release/rollback records include signed `retainedBytesDelta` and resulting totals. Budget diagnostics are captured before synchronous release. Idempotent retirement emits one release, using the last associated observation/attempt index rather than the next index. `reason: 'stateDisposed'` covers chat/session eviction, unregister, and service disposal; other reasons distinguish horizon, budget rejection, cancellation, and failure.

These are input-volume and conservative retained-accounting signals, not allocated bytes, simultaneous resident input, actual heap, peak RSS, or synchronous GC reclamation. Per-file input is null when metadata is unavailable; file-specific fields are absent on lifecycle-wide events. Events contain no paths, blob contents, or diff payloads. On-demand storage is still unimplemented.

Expiry releases add `reason: 'idleExpired' | 'maximumAgeExceeded'` at the terminal's associated index; budget rejection during final comparison retains the budget release reason. No new cost-event kind or schema version is introduced. Unavailable pre-computation expiry reports explicit not-started comparisons rather than fabricated zero CPU.

`requestDiffSurvivalCost.test.ts` uses injected worker measurements and clocks to verify timing/CPU aggregation, unsupported/failed measurements, materialization failures, not-started/reuse semantics, and logging failures. `requestDiffSurvival.test.ts` covers real contribution correlation, cross-chat retained totals, budget proposals/releases, rollback, disabled logging, and the existing survival/cadence behavior. Its injectable expiry scheduler tests exact deadlines, activity/reset/isolation, fresh-state survival changes, capture and computation failures, budgets, queued/in-flight races, log-failure isolation, horizon finalization, and disposal.

### Hybrid worker engine

Survival uses only `worker-hybrid`: VS Code line alignment plus raw character refinement through the existing diff worker. Enable it with `VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG=1`. The experimental pure-character engines and engine environment selector have been removed. This remains an opt-in local experiment, not a new product configuration or permission.

Worker operations use the existing 5,000 ms cooperative algorithm timeout. A timeout/algorithm or transport failure emits a final unavailable survival observation with `unavailableReason: 'computationFailed'`, no diff payload, and -1 survival values; it retires the tracker. Raw hybrid mappings are translated to full-document UTF-16 offsets; a linear gap pass restores newline-only edits omitted by the line engine without replacing the whole file or falling back to whole-file character LCS. Unexpected unmatched text is an explicit failure. Alignment can differ from historical whole-text character results even when both reconstruct the exact text.

Compute schema 2 labels `engine: worker-hybrid`, `algorithm: hybrid`, `executionLocation: worker`, and `measurementScope: diffAndOffsetMapping`, including line splitting/alignment/refinement and exact-offset/newline mapping, but excluding host range/text materialization and transfer/queueing. Worker CPU readings run inside the worker, not on the host across an await and not process-wide. `serviceCallElapsedMs` separately measures host call latency (including cold startup, queueing, and transfers); aggregate values sum per-file latencies and are not an observation wall-clock span. Do not add them to overlapping algorithm elapsed/CPU. Worker file events add `computationOutcome: 'completed' | 'timedOut' | 'failed' | 'unknown'`; unavailable transport measurements make aggregate CPU/algorithm elapsed null, not partial sums presented as complete.

Input preflight rejects before dispatch; retained reservations and stale-result checks still run on the host. Chat/session eviction and expiry can retire a pending tracker without resurrecting it when its result arrives. Already-dispatched jobs, including queued jobs, are not removed or forcibly interrupted: they finish or cooperatively time out, with actual returned costs recorded even if attribution was cancelled. No shared worker is killed to cancel one tracker. Worker loss/disposal rejects pending calls, and a disposed service cannot spawn another worker. This is not a hard end-to-end deadline, queue/backlog bound, or temporary-memory limit.

Run the focused survival/contribution/cost suites via `scripts/test.sh`. Real-worker cases in [survivalDiff.test.ts](./survivalDiff.test.ts) must also run in Node because Electron's test renderer cannot construct Node workers:

```bash
pnpm run test-node --run src/vs/platform/agentHost/test/node/survivalDiff.test.ts
```

The engine suite verifies real worker messaging/measurements/disposal, exact reconstruction (including deterministic mixed-newline edits), A/B coordinate intersections, timeout results, and CPU-read failure isolation. Contribution tests verify preflight-before-dispatch, reuse/cadence, timeout retirement, and stale-result cleanup.

## Request-survival responsiveness diagnostics

Enable the local collector with `VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_DIAGNOSTICS=1` and restart the host. It is independent of survival logging: leave diagnostics enabled with the survival `LOG` flag absent or `0` for the disabled baseline. Enable hybrid survival with `VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG=1`; no engine selector is needed. No product telemetry, synthetic probes, or scheduling changes are added.

Keep experiment dashboards to **three metrics**:

| Metric | Log selection | Interpretation |
| --- | --- | --- |
| Diff CPU per observation | Existing `requestCharacterDiffComputeObservation`, `phase: observation`, `cpuMeasurementStatus: available`; use `cpuTotalMs` | Compare matching origins/indices against saved hybrid runs. Never add nested file/comparison totals. |
| Maximum host event-loop delay | Diagnostics `phase: window`; take maximum available `eventLoop.maxMs` over the measured interval | Compare disabled and hybrid over equivalent workload/recovery intervals. These elapsed samples include the normal 10 ms monitor interval; they are not exact blocking durations. |
| Background drain after the final request | Diagnostics `phase: drain`, `sinceLastEligibleTurnEndMs` on the first drain after the final turn-end task completes | In an isolated run with no later requests, measures elapsed time from final eligible turn end until background work reaches zero. Disabled baseline is N/A. Missing drain is unavailable/unfinished, not zero. |

Diagnostic lines use **`[RequestDiffSurvivalDiagnostics] `**, `recordKind: requestDiffSurvivalDiagnostics`, and schema 1. Group by `diagnosticsRunId` and order by `sequence`; records include UTC timestamp, engine (or `disabled`), `timeUnit: ms`, and `timingKind: elapsed`. Extract JSONL with:

```bash
sed -n 's/^.*\[RequestDiffSurvivalDiagnostics\] //p' "$LOG"
```

Keep failures, rejected work, sample counts, and shutdown unfinished counts as validity checks, not additional performance panels. Empty samples/null CPU/missing records are not zero cost. Allow recovery windows after edits; immediate termination can miss a final stall. A manual run that waits between requests cannot establish sustained-load behavior.

Other fields are troubleshooting details only. Background task counts are not observation/file counts; one `turnEnd` task can process several observations. Task queue wait excludes processing, while observation `sinceTaskEnqueuedMs` includes checkpoint and preceding-observation waits. Durations overlap; do not sum them or average window p95s into a run percentile. Full typed record shapes live in [requestDiffSurvivalDiagnostics.ts](../../node/chatContributions/requestDiffSurvival/requestDiffSurvivalDiagnostics.ts); focused tests are [requestDiffSurvivalDiagnostics.test.ts](./requestDiffSurvivalDiagnostics.test.ts) and [requestDiffSurvival.test.ts](./requestDiffSurvival.test.ts).

## Request-survival attribution coverage

Every experimental `requestCharacterDiffSurvivalObservation` includes `originalRequestUsedEditTool`. The contribution collects provider-owned tool outcomes synchronously within the originating request, including parent and nested-subagent tools, and freezes the value at success, cancellation, or non-resumable error. Later observations repeat that value; a resumable error does not finalize it. This field does not filter requests or change the observation horizon, diff metrics, telemetry consent, or experiment opt-in.

`true` means a recognized native edit tool executed, even if it failed or made no change; terminal-only commands and denied-before-execution invocations do not qualify. Copilot reuses `isEditTool(toolName, command)` and its SDK success/failure outcomes (SDK execution-start events precede permission checks and are not sufficient evidence). Claude reuses `isClaudeFileEditTool` and successful results. `false` means a supported provider finished the observed tool lifecycles without such an attempt. `null` means no positive evidence was available and coverage was insufficient: unsupported providers, client/MCP tools, unfinished calls, ambiguous Copilot outcomes, or Claude edit failures that its result stream cannot distinguish from SDK-owned pre-execution denial. Positive evidence remains `true` despite other unknown calls. No editor/other-source activity flag is collected.

`vscode.toolRequest` preserves the provider's root chat and request identity before subagent routing remaps action turn IDs, so reusable descendants and late outcomes cannot be attributed to a later request. Provider evidence metadata is emitted only under the existing experiment opt-in; protocol action turn IDs remain unchanged. Focused cases in `requestDiffSurvival.test.ts`, `copilotAgentSession.test.ts`, `claudeMapSessionEvents.test.ts`, `copilotToolDisplay.test.ts`, `claudeToolDisplay.test.ts`, and `agentToolCallMeta.test.ts` cover execution classification, metadata validation, queued-checkpoint races, request-end freezing, nested routing, and missing coverage.

## Request-survival experiment log retention

With `VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG=1`, the utility-process Agent Host and non-quiet standalone Agent Host use a 100 MiB per-file limit with six rotated backups plus the current file (approximately 700 MiB of bounded retention). Without that exact flag value, their normal 5 MiB per-file limit remains unchanged. Other loggers keep their existing limits. This is local diagnostic retention, not a new telemetry consent or managed setting.

Log rotation is size-based, not duration-based. Export all current and rotated Agent Host log files promptly after an experiment; sufficiently verbose or long runs can still rotate away early observations. Changing the limit requires rebuilding and restarting the host and cannot recover previously deleted history.

The retention case in [agentHostBootstrap.test.ts](./agentHostBootstrap.test.ts) covers the flag gate used by both entry points. [loggerService.test.ts](../../../log/test/node/loggerService.test.ts) exercises the real native logger at the default 5 MiB and experiment 100 MiB thresholds, verifies the six-backup bound, and rejects invalid overrides.

```bash
./scripts/test.sh --run src/vs/platform/log/test/node/loggerService.test.ts --run src/vs/platform/agentHost/test/node/agentHostBootstrap.test.ts --grep 'Native logger retention|log retention' --reporter dot
```

## Reasoning timing

AHP reasoning parts carry optional producer-owned `startedAt` and `duration` fields for one contiguous run of thinking output. A run starts at its first nonempty reasoning text and ends at the next markdown or tool-call part, or at turn termination. SDK reasoning IDs, reasoning-complete events, full-message boundaries, and sideband notifications do not split a run. Timing-only `chat/reasoning` updates finish the run before publishing the following content or terminal action.

Copilot measures runs with a monotonic clock and stores the observed ordering of reasoning, markdown, and tool references against durable assistant-message event IDs in `assistant_response_parts`. A run may span SDK messages; its fragments share one ID and are updated with the same final duration, then reassembled without summing it during replay. Conversely, two runs separated by markdown or a tool retain separate IDs and durations even when the SDK saves one message containing both. Native tool results are retained and placed at the recorded boundaries. The projection is used only when its text still matches the provider transcript.

Recorded parts follow turn remapping and pruning. The earlier draft's aggregate `reasoning_timing` rows are not reinterpreted as per-run timings. Unknown history and unfinished runs remain untimed rather than counting time while the host is stopped. This does not add capture to other providers or estimate older history.

Conversation import stores the original reasoning projections against the synthesized assistant-message IDs before resuming the SDK session, so imported durations also survive restart. The workbench marks every AHP thinking part as provider-owned independently of whether it carries timing values; a live delta after reconnect must never turn a locally observed tail into a persisted total. Local, non-AHP providers retain their existing client-side timing.

Single-run thinking headers use labels such as "Thought for 5s". Labels round the recorded millisecond duration up to whole seconds, with a 1s minimum, so a short run never reads as "Thought for 0s"; the stored duration itself is unchanged. Conversation grouping remains available, but its expanded reasoning rows show their individual durations instead of a group-wide sum. `copilotReasoningTiming.test.ts` covers 5s/12s markdown/tool boundaries through a real database restart and a single run spanning SDK messages. The provider, model, database, and renderer tests cover live boundaries, identity, migration, serialization, grouped display, and accessible text.

Finalized sections refresh both visible and accessible timing when a duration arrives after answer text. Regression coverage includes string/array reasoning, an earlier run inside a completed conversation group, and an import/event-log/database reopen round trip.

## Mission Control session configuration

The Mission Control listener publishes Copilot Host's `approvalMode` vocabulary (`manual`, `assisted`, `allow-all`) in place of VS Code's native `autoApprove` vocabulary (`default`, `assisted`, `autoApprove`). The independent `mode` property advertises `interactive`, `plan`, and `autopilot`. Local clients and persisted configuration keep the native representation; Mission Control requests, snapshots, action echoes, and reconnect replay use the wire representation.

Workspace configuration uses `target` (`workspace`, `worktree`) and `baseBranch` on Mission Control, mapped to native `isolation` (`folder`, `worktree`) and `branch`. Schema enums, defaults, labels, required keys, and branch completion requests use the corresponding vocabulary. Schema projection translates only recognized axes and preserves generic or mixed-vocabulary properties and their values. Native input names remain accepted for older clients; conflicting native and wire values are rejected.

`MissionControlHost` injects the configuration adapter separately from the Copilot extension contribution. The generic protocol handler delegates configuration conversion, including rejected-action projection, without interpreting Copilot property names. The extension contribution registers project and session methods and supplies the public root catalogue; authentication, passive restrictions, channel visibility, and replay remain handler-owned.

`missionControlSessionConfig.test.ts` covers the mapping and schema, and the `Mission Control session configuration` suite in `protocolServerHandler.test.ts` covers both sides of the protocol boundary. Run them with:

```bash
./scripts/test.sh --run src/vs/platform/agentHost/test/node/missionControlSessionConfig.test.ts --run src/vs/platform/agentHost/test/node/protocolServerHandler.test.ts --grep "Mission Control session config"
```

The `listener extensions` suite checks arbitrary contribution methods, authentication, passive access (including collisions with built-in methods), and listener-owned live/replay projections. Built-in handlers take precedence, and extension metadata cannot grant passive access to a mutating built-in. `missionControlHost.test.ts` checks the injected Copilot implementation and host wiring:

```bash
./scripts/test.sh --run src/vs/platform/agentHost/test/node/protocolServerHandler.test.ts --run src/vs/platform/agentHost/test/node/missionControlHost.test.ts --grep "listener extensions|MC Copilot extensions|Mission Control host integration"
```

## MCP routing rollout telemetry

`agentHost.mcpUsageStarted` and `agentHost.mcpUsageCompleted` observe live Copilot root turns in both routing arms, including turns with no tool use. The session's immutable `routingEnabled` value describes effective behavior; `toolSearchActive` and `configuredServerCount` are snapshots at turn start. The configured inventory is computed identically in both arms from user, workspace and plugin configuration and already-discovered Connectors, excluding launch-disabled servers. It is not a measure of user intent, successful connections, or all servers that may arrive later. Restored history does not generate usage. Child tool activity observed during the root turn is included, not reported again as independent root turns. A mapped subagent error does not finalize the root usage tracker. SDK tool outcomes are counted when observed, before asynchronous resource persistence or UI publication; client-side authentication cancellation is also counted before retiring its tool call.

The primary rollout outcome is an observed successful **real MCP tool call**, not a routing proxy connection or an OAuth token. `mcpToolCalls`, `mcpToolSuccesses`, `mcpToolErrors`, `mcpToolCancellations` and `serversUsed` exclude proxies. The parallel `routingTool*` counters describe proxy selection and completion separately. `searches` and `searchesReturningRoutingTools` count successful host-overridden tool searches, including empty results, and how many returned at least one registered proxy. They do not measure searches performed outside that override or whether the model actually consumed a result. Tool starts without observed completion remain in starts but not outcome counters; duplicate starts/completions are deduplicated within the turn. Server names and tool-call IDs stay in memory and are discarded when the turn ends.

Join starts to completions by `sdkSessionId`, `chatSessionId` and `turnId`. Keep zero-use turns in the denominator, and report missing completions separately: a crash can leave a start without a completion, while disposal without a terminal outcome reports `interrupted`. Do not filter the population on proxy selection, sign-in, connected servers, or tool success, since routing changes those outcomes. Compare the share of started turns and initiating devices with at least one successful real MCP call, alongside calls, errors, cancellations and unresolved starts. Treat `configuredServerCount > 0` and `toolSearchActive` as descriptive start-time strata rather than proof of MCP intent or a complete experiment-exposure trigger.

For randomized A/B analysis, use the existing experiment assignment context and treatment `config.chat.agentHost.experimental.mcpToolRouting` (the setting remains off by default). Effective routing state alone is not random assignment: user overrides and older live sessions can differ from the current assignment. Restrict to a build shipping these events, separate assignment from effective state, exclude missing assignments from randomized comparisons, and account for devices appearing in both effective cohorts. No approximate experiment trigger is added because proactive-hint suppression and tool registration can affect a session before any routing tool is selected.

`agentHost.mcpAuthentication` reports settled SDK authentication callbacks in both arms, including background requests. It captures the initiating turn (if any), whether a related tool call was active, effective routing state, an opaque request ID, duration, and `tokenProvided`, `runtimeRefresh`, `cancelled`, `unhandled` or `failed`. SDK callback outcomes and duration are recorded outside the cancellation guard, so callbacks interrupted or received during abort report the result returned to the SDK, even if an underlying token lookup later succeeds. Providing a token or requesting refresh is **not server acceptance**. Callback cancellation can be caused by turn/session teardown; it is not necessarily a user cancelling OAuth. Reuse of an existing token counts as token provision. These events do not measure sign-in prompt impressions or clicks, and are not an authentication conversion rate. Use successful real tool use as the rollout guardrail; renderer-visible impressions, explicit UI actions and server-verified authentication would need separate instrumentation for a UI conversion study.

All events use existing telemetry consent and assignment plumbing. No names, URLs, scopes, tool arguments, content, tokens or configuration values other than the routing boolean are added. Numbers and booleans are measurements. Focused coverage exercises both arms, zero-use turns, proxy-only success, real MCP outcomes, deduplication, interrupted/late completion, authentication cancellation and turn attribution, and credential exclusion:

```bash
pnpm run build-fast --client-only
./scripts/test.sh --run src/vs/platform/agentHost/test/node/copilotMcpUsageTelemetry.test.ts --run src/vs/platform/agentHost/test/node/copilotAgentSession.test.ts --grep "Copilot MCP usage telemetry|MCP usage telemetry|MCP authentication telemetry|MCP routing|cached MCP tools|configured MCP server adds|tool-search"
```
