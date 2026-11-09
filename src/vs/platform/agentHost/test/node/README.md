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

The snapshot tests in [agentEditAttributionService.test.ts](./agentEditAttributionService.test.ts) separately verify cumulative counts across successive turns, repeated non-destructive reads, and epoch advancement after an explicit flush. They do not replace a live provider check of runtime refreshes and survival logs.

## Request-survival model metadata

Outgoing contributions receive the explicit or inherited model selection captured by the send path after selection updates. The survival logger captures that selection's identifier synchronously at the originating boundary and retains it independently of later chat model changes. `baseModel` and `observationModel` describe selections, not provider-resolved executing models; Auto/Fusion remains a selection and unresolved values stay null.

The effective-selection cases in [requestDiffSurvival.test.ts](./requestDiffSurvival.test.ts) cover both line and character records, inherited selection, explicit override, unknown values, Auto/Fusion, and later model changes. The model-selection suite in [agentSideEffects.test.ts](./agentSideEffects.test.ts) verifies that the real send path forwards those facts without changing the outgoing message.

## Request-survival attribution coverage

Every experimental `requestDiffSurvivalObservation` and `requestCharacterDiffSurvivalObservation` includes `originalRequestUsedEditTool`. The contribution collects provider-owned tool outcomes synchronously within the originating request, including parent and nested-subagent tools, and freezes the value at success, cancellation, or non-resumable error. Later observations repeat that value; a resumable error does not finalize it. This field does not filter requests or change the observation horizon, diff metrics, character snapshots, telemetry consent, or experiment opt-in.

`true` means a recognized native edit tool executed, even if it failed or made no change; terminal-only commands and denied-before-execution invocations do not qualify. Copilot reuses `isEditTool(toolName, command)` and its SDK success/failure outcomes (SDK execution-start events precede permission checks and are not sufficient evidence). Claude reuses `isClaudeFileEditTool` and successful results. `false` means a supported provider finished the observed tool lifecycles without such an attempt. `null` means no positive evidence was available and coverage was insufficient: unsupported providers, client/MCP tools, unfinished calls, ambiguous Copilot outcomes, or Claude edit failures that its result stream cannot distinguish from SDK-owned pre-execution denial. Positive evidence remains `true` despite other unknown calls. No editor/other-source activity flag is collected.

`vscode.toolRequest` preserves the provider's root chat and request identity before subagent routing remaps action turn IDs, so reusable descendants and late outcomes cannot be attributed to a later request. Provider evidence metadata is emitted only under the existing experiment opt-in; protocol action turn IDs remain unchanged. Focused cases in `requestDiffSurvival.test.ts`, `copilotAgentSession.test.ts`, `claudeMapSessionEvents.test.ts`, `copilotToolDisplay.test.ts`, `claudeToolDisplay.test.ts`, and `agentToolCallMeta.test.ts` cover execution classification, metadata validation, queued-checkpoint races, request-end freezing, nested routing, and missing coverage.

Schema version 2 of `requestFocusWindowSurvivalSnapshot` separates collection success (`complete`/`status`) from attribution policy (`attributionCoverage`). Renderer longterm excludes correlated host-owned observations; 10/20-minute windows can reattribute them and are not human-only. `excludedAgentHostObservationCount` counts excluded correlated observations, including zero-survivor observations; it is null when no tracker was sampled. It is not a character count or a unique edit total across snapshots.

The host `requestCharacterSurvivalSnapshot` remains a separate session/chat aggregate. Do not sum it with per-document renderer windows or treat an empty renderer component as zero agent survival. Old schema-1 records lack explicit coverage metadata and must remain legacy/unspecified in consumers. New collection metadata does not change consent, eligibility, suppression, or natural-report ownership.

[requestFocusWindowSurvival.test.ts](./requestFocusWindowSurvival.test.ts) verifies coverage survives management IPC and distinguishes unavailable collection. The workbench `editTracker.test.ts` and `editSourceTrackingImpl.test.ts` suites cover exclusion counts, empty versus suppressed sources, unresolved correlation, and unchanged non-destructive sampling.

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
