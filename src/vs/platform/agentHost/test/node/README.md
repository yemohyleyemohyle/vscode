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
