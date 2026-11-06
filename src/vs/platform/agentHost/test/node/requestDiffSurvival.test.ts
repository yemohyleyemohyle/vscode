/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import sinon from 'sinon';
import { DeferredPromise } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { LcsDiff } from '../../../../base/common/diff/diff.js';
import { observableValue, type ISettableObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IAgentHostCheckpointService, NULL_CHECKPOINT_SERVICE } from '../../common/agentHostCheckpointService.js';
import type { IAgentHostChatContributionContext, IChatMementoKey, ISessionMementoKey } from '../../common/agentHostChatContributionsService.js';
import { IAgentHostGitService } from '../../common/agentHostGitService.js';
import { NullAgentEditAttributionService } from '../../common/fileEditAttribution.js';
import { createSessionState, MessageKind, SessionStatus, ToolCallCancellationReason, type URI as ProtocolURI } from '../../common/state/sessionState.js';
import { ActionType, type ChatAction } from '../../common/state/sessionActions.js';
import { AgentHostStateManager } from '../../node/agentHostStateManager.js';
import { RequestDiffSurvivalContribution } from '../../node/chatContributions/requestDiffSurvival/requestDiffSurvivalContribution.js';
import { computeRequestDiffFile, computeRequestDiffSurvivalMetric, type IRequestRepositoryDiff, type IRequestDiffSurvivalMetric } from '../../node/chatContributions/requestDiffSurvival/requestDiffSurvival.js';
import { createNoopGitService } from '../common/sessionTestHelpers.js';
import type { IRequestCharacterRepositoryDiff } from '../../node/chatContributions/requestDiffSurvival/requestCharacterDiffSurvival.js';
import type { IRequestEditSurvivalBoundary } from '../../common/requestEditSurvival.js';

suite('Agent Host Request Diff Survival', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	teardown(() => sinon.restore());

	test('matches the proposal survival examples', () => {
		const scenarios = [
			{ name: 'retained addition', states: ['a', 'a\nnew', 'a\nnew'], expected: [1, 0, 1, 0, 1] },
			{ name: 'removed addition', states: ['a', 'a\nnew', 'a'], expected: [0, 0, 1, 0, 0] },
			{ name: 'retained pure deletion', states: ['a\nb\nc', 'a\nc', 'a\nc'], expected: [0, 1, 0, 1, 1] },
			{ name: 'restored deletion', states: ['a\nb\nc', 'a\nc', 'a\nb\nc'], expected: [0, 0, 0, 1, 0] },
			{ name: 'revised replacement', states: ['value = 1', 'value = 2', 'value = 3'], expected: [0, 1, 1, 1, 0.5] },
		] as const;

		assert.deepStrictEqual(scenarios.map(scenario => {
			const [baseline, requestResult, latest] = scenario.states;
			const metric = computeRequestDiffSurvivalMetric(
				diff('s0', 's1', baseline, requestResult),
				diff('s0', 'latest', baseline, latest),
				diff('s1', 'latest', requestResult, latest),
			);
			return {
				name: scenario.name,
				actual: [metric.survivingAdditions, metric.survivingDeletions, metric.totalAdditions, metric.totalDeletions, metric.ratio],
				expected: [...scenario.expected],
			};
		}), scenarios.map(scenario => ({
			name: scenario.name,
			actual: [...scenario.expected],
			expected: [...scenario.expected],
		})));
	});

	test('keeps duplicate lines distinct by their state-relative line numbers', () => {
		const metric = computeRequestDiffSurvivalMetric(
			diff('s0', 's1', 'a\na', 'a'),
			diff('s0', 's2', 'a\na', 'a\nb'),
			diff('s1', 's2', 'a', 'a\nb'),
		);

		assert.deepStrictEqual(metric, {
			survivingAdditions: 0,
			survivingDeletions: 1,
			totalAdditions: 0,
			totalDeletions: 1,
			totalSurviving: 1,
			totalEdits: 1,
			ratio: 1,
		});
	});

	test('returns null for a request without a net edit', () => {
		const metric = computeRequestDiffSurvivalMetric(
			diff('s0', 's1', 'a', 'a'),
			diff('s0', 's2', 'a', 'b'),
			diff('s1', 's2', 'a', 'b'),
		);

		assert.strictEqual(metric.ratio, null);
	});

	for (const scenario of [
		{ name: 'no tools', expected: false },
		{ name: 'parent executed edit', executed: true, expected: true },
		{ name: 'nested executed edit', toolChat: 'grandchild', executed: true, expected: true },
		{ name: 'failed or no-op executed edit', executed: true, failed: true, expected: true },
		{ name: 'terminal-only execution', executed: false, expected: false },
		{ name: 'denied before execution', denied: true, expected: false },
		{ name: 'rejected execution action', executed: true, rejected: true, expected: null },
		{ name: 'unsupported executed tool', tool: true, expected: null },
		{ name: 'unfinished proposed tool', tool: true, unfinished: true, expected: null },
		{ name: 'unsupported provider', provider: 'codex', expected: null },
		{ name: 'resumable failure', executed: true, resumable: true, expected: true },
	] satisfies readonly {
		name: string; expected: boolean | null; executed?: boolean; toolChat?: string; failed?: boolean;
		denied?: boolean; rejected?: boolean; tool?: boolean; unfinished?: boolean; provider?: string; resumable?: boolean;
	}[]) {
		test(`freezes originating edit-tool evidence before queued checkpoints: ${scenario.name}`, async () => {
			const previousValue = process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG;
			process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG = '1';
			try {
				const start = new DeferredPromise<void>();
				const repository = URI.file('/repo');
				const log = new RecordingObservationLogService();
				const contribution = disposables.add(new RequestDiffSurvivalContribution(
					new TestContributionContext(), log,
					{
						...NULL_CHECKPOINT_SERVICE,
						getTurnStartCheckpointState: async () => {
							await start.p;
							return [{ repository, tree: 'before' }];
						},
						waitForTurnCheckpointPair: async () => ({ parent: 'before', current: 'after' }),
					},
					createNoopGitService(), new NullAgentEditAttributionService(), createStateManager(scenario.provider),
				));
				const send = (turnId: string) => contribution.onOutgoingTurn({
					session: 'session', chat: 'chat', turnId,
					message: { text: 'request', origin: { kind: MessageKind.User } },
				});
				const dispatch = (action: ChatAction, channel = 'chat', rejected = false) => contribution.onDidDispatchAction({
					session: 'session', channel, action, rejectionReason: rejected ? 'rejected' : undefined,
				});
				const requestMeta = { 'vscode.toolRequest': { chat: 'chat', turnId: 'base' } };
				const completion = (executed: boolean | undefined): ChatAction => ({
					type: ActionType.ChatToolCallComplete, toolCallId: 'tool', turnId: 'child-turn',
					result: { success: !scenario.failed, pastTenseMessage: 'finished' },
					_meta: { ...requestMeta, 'vscode.editToolExecution': executed },
				});
				send('base');
				if (scenario.executed !== undefined || scenario.tool || scenario.denied) {
					dispatch({
						type: ActionType.ChatToolCallStart, toolCallId: 'tool', toolName: 'edit', displayName: 'Edit',
						turnId: 'child-turn', _meta: requestMeta,
					}, scenario.toolChat);
					if (scenario.denied) {
						dispatch({
							type: ActionType.ChatToolCallConfirmed, toolCallId: 'tool', turnId: 'child-turn',
							approved: false, reason: ToolCallCancellationReason.Denied,
						}, scenario.toolChat);
						dispatch(completion(undefined), scenario.toolChat);
					} else if (!scenario.unfinished) {
						dispatch(completion(scenario.executed), scenario.toolChat, scenario.rejected);
					}
				}
				if (scenario.resumable) {
					contribution.onTurnEnd({
						session: 'session', channel: 'chat', turnId: 'base',
						reason: { kind: 'error', error: { errorType: 'requestFailed', message: 'retry' }, resumable: true },
					});
				}
				const ended = log.whenRequestEnds('base');
				contribution.onTurnEnd({ session: 'session', channel: 'chat', turnId: 'base', reason: { kind: 'success' } });
				await start.complete();
				await ended;
				const laterEnded = log.whenRequestEnds('later');
				send('later');
				dispatch(completion(true), 'grandchild');
				contribution.onTurnEnd({ session: 'session', channel: 'chat', turnId: 'later', reason: { kind: 'cancelled' } });
				await laterEnded;
				const project = (records: readonly IRecordedObservation[]) => records.map(record => ({
					request: record.originatingRequestId,
					used: record.originalRequestUsedEditTool,
					otherSourceFlag: Object.hasOwn(record, 'originalRequestHadOtherSourceEdits'),
				}));
				const expected = [
					{ request: 'base', used: scenario.expected, otherSourceFlag: false },
					{ request: 'base', used: scenario.expected, otherSourceFlag: false },
					{ request: 'base', used: scenario.expected, otherSourceFlag: false },
					{ request: 'later', used: scenario.provider === 'codex' ? null : false, otherSourceFlag: false },
				];
				assert.deepStrictEqual({ line: project(log.observations), character: project(log.characterObservations) }, {
					line: expected, character: expected,
				});
			} finally {
				if (previousValue === undefined) {
					delete process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG;
				} else {
					process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG = previousValue;
				}
			}
		});
	}

	for (const scenario of [
		{ name: 'inherited', explicit: undefined, effective: 'kimi-k3', expected: 'kimi-k3' },
		{ name: 'explicit override', explicit: 'gpt-5', effective: 'kimi-k3', expected: 'gpt-5' },
		{ name: 'unknown', explicit: undefined, effective: undefined, expected: null },
		{ name: 'Auto selection', explicit: undefined, effective: 'auto', expected: 'auto' },
		{ name: 'Fusion selection', explicit: undefined, effective: 'hydrafusion', expected: 'hydrafusion' },
	]) {
		test(`captures effective model metadata at the request boundary: ${scenario.name}`, async () => {
			const previousValue = process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG;
			process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG = '1';
			try {
				const repository = URI.file('/repo');
				const logService = new RecordingObservationLogService();
				const contribution = disposables.add(new RequestDiffSurvivalContribution(
					new TestContributionContext(), logService,
					{
						...NULL_CHECKPOINT_SERVICE,
						getTurnStartCheckpointState: async () => [{ repository, tree: 'before' }],
						waitForTurnCheckpointPair: async () => ({ parent: 'before', current: 'after' }),
					},
					createNoopGitService(), new NullAgentEditAttributionService(), createStateManager(),
				));
				const ended = logService.whenRequestEnds('base');
				const effectiveModel = scenario.effective === undefined ? undefined : { id: scenario.effective };
				contribution.onOutgoingTurn({
					session: 'session', chat: 'chat', turnId: 'base', effectiveModel,
					message: { text: 'base', origin: { kind: MessageKind.User }, model: scenario.explicit === undefined ? undefined : { id: scenario.explicit } },
				});
				if (effectiveModel) {
					effectiveModel.id = 'changed-after-boundary';
				}
				contribution.onTurnEnd({ session: 'session', channel: 'chat', turnId: 'base', reason: { kind: 'success' } });
				await ended;
				const laterEnded = logService.whenRequestEnds('later');
				contribution.onOutgoingTurn({
					session: 'session', chat: 'chat', turnId: 'later', effectiveModel: { id: 'later-model' },
					message: { text: 'later', origin: { kind: MessageKind.User } },
				});
				contribution.onTurnEnd({ session: 'session', channel: 'chat', turnId: 'later', reason: { kind: 'success' } });
				await laterEnded;
				const project = (records: readonly IRecordedObservation[]) => records.map(record => ({
					base: record.baseModel, observing: record.observationModel, origin: record.originatingRequestId,
					request: record.observationRequestId, boundary: record.observationBoundary,
				}));
				const expected = [
					{ base: scenario.expected, observing: scenario.expected, origin: 'base', request: 'base', boundary: 'requestEnd' },
					{ base: scenario.expected, observing: 'later-model', origin: 'base', request: 'later', boundary: 'requestStart' },
					{ base: scenario.expected, observing: 'later-model', origin: 'base', request: 'later', boundary: 'requestEnd' },
					{ base: 'later-model', observing: 'later-model', origin: 'later', request: 'later', boundary: 'requestEnd' },
				];
				assert.deepStrictEqual({ line: project(logService.observations), character: project(logService.characterObservations) }, {
					line: expected, character: expected,
				});
			} finally {
				if (previousValue === undefined) {
					delete process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG;
				} else {
					process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG = previousValue;
				}
			}
		});
	}

	test('logs models and timestamps without derived state labels', async () => {
		const environmentVariable = 'VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG';
		const previousValue = process.env[environmentVariable];
		process.env[environmentVariable] = '1';
		try {
			const repository = URI.file('/repo');
			const logService = new ObservationLogService();
			const checkpointService: IAgentHostCheckpointService = {
				...NULL_CHECKPOINT_SERVICE,
				getTurnStartCheckpointState: async (_session, _chat, turnId) => [{ repository, tree: `${turnId}-start` }],
				waitForTurnCheckpointPair: async (_session, _chat, turnId) => ({ parent: `${turnId}-start`, current: `${turnId}-end` }),
			};
			const gitService: IAgentHostGitService = {
				...createNoopGitService(),
				computeFileDiffsBetweenRefs: async () => [],
			};
			const focusBoundaries: IRequestEditSurvivalBoundary[] = [];
			const attributionService = new class extends NullAgentEditAttributionService {
				override requestFocusWindowSnapshot(boundary: IRequestEditSurvivalBoundary): void {
					focusBoundaries.push(boundary);
				}
			};
			const contribution = disposables.add(new RequestDiffSurvivalContribution(
				new TestContributionContext(),
				logService,
				checkpointService,
				gitService,
				attributionService,
				createStateManager(),
			));
			const session = 'ahp-session:/session';
			const chat = 'ahp-chat:/chat';

			contribution.onOutgoingTurn({
				session,
				chat,
				turnId: 'base-request',
				message: { text: 'base', origin: { kind: MessageKind.User }, model: { id: 'kimi-k3' } },
			});
			contribution.onTurnEnd({ session, channel: chat, turnId: 'base-request', reason: { kind: 'success' } });
			const baseObservation = JSON.parse(await logService.firstObservation.p);

			contribution.onOutgoingTurn({
				session,
				chat,
				turnId: 'later-request',
				message: { text: 'later', origin: { kind: MessageKind.User }, model: { id: 'gpt-5' } },
			});
			const laterObservation = JSON.parse(await logService.secondObservation.p);

			assert.deepStrictEqual({
				focusBoundaries: focusBoundaries.map(boundary => ({ request: boundary.observationRequestId, boundary: boundary.observationBoundary })),
				focusTimestampsMatch: focusBoundaries[1].observationTimestamp === baseObservation.observationTimestamp && focusBoundaries[2].observationTimestamp === laterObservation.observationTimestamp,
				base: observationShape(baseObservation),
				later: observationShape(laterObservation),
				baseTimestampsMatchAcrossObservations:
					baseObservation.baseStartTimestamp === laterObservation.baseStartTimestamp
					&& baseObservation.baseEndTimestamp === laterObservation.baseEndTimestamp,
			}, {
				focusBoundaries: [
					{ request: 'base-request', boundary: 'requestStart' },
					{ request: 'base-request', boundary: 'requestEnd' },
					{ request: 'later-request', boundary: 'requestStart' },
				],
				focusTimestampsMatch: true,
				base: {
					schemaVersion: 2,
					originatingRequestId: 'base-request',
					observationRequestId: 'base-request',
					baseModel: 'kimi-k3',
					observationModel: 'kimi-k3',
					observationBoundary: 'requestEnd',
					observationIndex: 0,
					hasIsoTimestamps: true,
					baseTimestampsOrdered: true,
					indexZeroTimestampMatchesBaseEnd: true,
					hasStates: false,
					diffKeys: ['files', 'errors'],
				},
				later: {
					schemaVersion: 2,
					originatingRequestId: 'base-request',
					observationRequestId: 'later-request',
					baseModel: 'kimi-k3',
					observationModel: 'gpt-5',
					observationBoundary: 'requestStart',
					observationIndex: 1,
					hasIsoTimestamps: true,
					baseTimestampsOrdered: true,
					indexZeroTimestampMatchesBaseEnd: true,
					hasStates: false,
					diffKeys: ['files', 'errors'],
				},
				baseTimestampsMatchAcrossObservations: true,
			});
		} finally {
			if (previousValue === undefined) {
				delete process.env[environmentVariable];
			} else {
				process.env[environmentVariable] = previousValue;
			}
		}
	});

	test('stops observing each originating request after index 19', async () => {
		const previousValue = process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG;
		process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG = '1';
		try {
			const repository = URI.file('/repo');
			const logService = new RecordingObservationLogService();
			const contribution = disposables.add(new RequestDiffSurvivalContribution(
				new TestContributionContext(),
				logService,
				{
					...NULL_CHECKPOINT_SERVICE,
					getTurnStartCheckpointState: async (_session, _chat, turnId) => [{ repository, tree: `${turnId}-start` }],
					waitForTurnCheckpointPair: async (_session, _chat, turnId) => ({ parent: `${turnId}-start`, current: `${turnId}-end` }),
				},
				{ ...createNoopGitService(), computeFileDiffsBetweenRefs: async () => [] },
				new NullAgentEditAttributionService(),
				createStateManager(),
			));
			for (let index = 0; index < 12; index++) {
				const turnId = `request-${index}`;
				const ended = logService.whenRequestEnds(turnId);
				contribution.onOutgoingTurn({
					session: 'ahp-session:/session',
					chat: 'ahp-chat:/chat',
					turnId,
					message: { text: 'request', origin: { kind: MessageKind.User } },
				});
				contribution.onTurnEnd({ session: 'ahp-session:/session', channel: 'ahp-chat:/chat', turnId, reason: { kind: 'success' } });
				await ended;
			}
			assert.deepStrictEqual(
				[logService.observations, logService.characterObservations].map(observations =>
					observations.filter(observation => observation.originatingRequestId === 'request-0').map(observation => ({
						index: observation.observationIndex,
						maximum: observation.maximumObservationCount,
						final: observation.isFinalObservation,
					}))),
				Array.from({ length: 2 }, () => Array.from({ length: 20 }, (_, index) => ({ index, maximum: 20, final: index === 19 }))),
			);
		} finally {
			if (previousValue === undefined) {
				delete process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG;
			} else {
				process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG = previousValue;
			}
		}
	});

	test('logs character diffs with the same boundary metadata and without extra blob reads', async () => {
		const previousValue = process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG;
		process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG = '1';
		try {
			const repository = URI.file('/repo');
			const logService = new RecordingObservationLogService();
			let blobReads = 0;
			let missingBlob = false;
			const contribution = disposables.add(new RequestDiffSurvivalContribution(
				new TestContributionContext(), logService,
				{
					...NULL_CHECKPOINT_SERVICE,
					getTurnStartCheckpointState: async () => [{ repository, tree: 'before' }],
					waitForTurnCheckpointPair: async () => ({ parent: 'before', current: 'after' }),
				},
				{
					...createNoopGitService(),
					computeFileDiffsBetweenRefs: async () => [{
						before: { uri: 'file:///repo/file', content: { uri: 'before' } },
						after: { uri: 'file:///repo/file', content: { uri: 'after' } },
						diff: { added: 1, removed: 1 },
					}],
					showBlob: async (_repository, ref) => {
						blobReads++;
						return missingBlob ? undefined : VSBuffer.fromString(ref === 'before' ? 'base' : 'base中文');
					},
				},
				new NullAgentEditAttributionService(),
				createStateManager(),
			));
			const ended = logService.whenRequestEnds('request');
			contribution.onOutgoingTurn({ session: 'session', chat: 'chat', turnId: 'request', message: { text: 'request', origin: { kind: MessageKind.User }, model: { id: 'model' } } });
			contribution.onTurnEnd({ session: 'session', channel: 'chat', turnId: 'request', reason: { kind: 'success' } });
			await ended;
			const character = logService.characterObservations[0];
			const line = logService.observations[0];
			assert.deepStrictEqual({
				blobReads,
				shape: observationShape(character),
				sameMetadata: observationShape(character).baseTimestampsOrdered === observationShape(line).baseTimestampsOrdered
					&& character.observationTimestamp === line.observationTimestamp,
				unit: character.unit,
				complete: character.complete,
				survival: character.survival,
				ranges: character.diffs.originalRequest.files[0].plus,
			}, {
				blobReads: 2,
				shape: { ...observationShape(line), schemaVersion: 1 },
				sameMetadata: true,
				unit: 'utf16CodeUnit', complete: true,
				survival: { survivingAdditions: 2, survivingDeletions: 0, totalAdditions: 2, totalDeletions: 0, totalSurviving: 2, totalEdits: 2, ratio: 1 },
				ranges: [{ path: `${repository.toString()}#file`, offset: 4, length: 2, text: '中文' }],
			});
			const failure = sinon.stub(LcsDiff.prototype, 'ComputeDiff').throws(new Error('character calculation failed'));
			for (const requestId of ['character-error', 'blob-error']) {
				missingBlob = requestId === 'blob-error';
				const finished = logService.whenRequestEnds(requestId);
				contribution.onOutgoingTurn({ session: 'session', chat: 'chat', turnId: requestId, message: { text: 'request', origin: { kind: MessageKind.User } } });
				contribution.onTurnEnd({ session: 'session', channel: 'chat', turnId: requestId, reason: { kind: 'success' } });
				await finished;
			}
			failure.restore();
			assert.deepStrictEqual(['character-error', 'blob-error'].map(requestId => {
				const line = logService.observations.find(record => record.originatingRequestId === requestId && record.observationIndex === 0)!;
				const character = logService.characterObservations.find(record => record.originatingRequestId === requestId && record.observationIndex === 0)!;
				return { lineComplete: line.complete, characterComplete: character.complete, hasCharacterErrors: character.diffs.originalRequest.errors.length > 0 };
			}), [
				{ lineComplete: true, characterComplete: false, hasCharacterErrors: true },
				{ lineComplete: false, characterComplete: false, hasCharacterErrors: true },
			]);
		} finally {
			if (previousValue === undefined) {
				delete process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG;
			} else {
				process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG = previousValue;
			}
		}
	});

	test('logs cumulative character snapshots with stable initial boundaries per tracking epoch', async () => {
		const environmentVariable = 'VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG';
		const previousValue = process.env[environmentVariable];
		process.env[environmentVariable] = '1';
		try {
			const logService = new CharacterObservationLogService();
			const contribution = disposables.add(new RequestDiffSurvivalContribution(
				new TestContributionContext(),
				logService,
				NULL_CHECKPOINT_SERVICE,
				createNoopGitService(),
				new SnapshotAgentEditAttributionService(),
				createStateManager(),
			));
			const session = 'ahp-session:/session';
			const chat = 'ahp-chat:/chat';

			contribution.onOutgoingTurn({
				session,
				chat,
				turnId: 'request-1',
				message: { text: 'first', origin: { kind: MessageKind.User } },
			});
			const requestStart = JSON.parse(await logService.observations[0].p);
			contribution.onTurnEnd({ session, channel: chat, turnId: 'request-1', reason: { kind: 'success' } });
			const requestEnd = JSON.parse(await logService.observations[1].p);
			contribution.onOutgoingTurn({
				session,
				chat,
				turnId: 'request-2',
				message: { text: 'second', origin: { kind: MessageKind.User } },
			});
			const afterFlush = JSON.parse(await logService.observations[2].p);

			assert.deepStrictEqual(
				[requestStart, requestEnd, afterFlush].map(characterObservationShape),
				[
					{
						recordKind: 'requestCharacterSurvivalSnapshot',
						trackingEpoch: 4,
						initialRequestId: 'request-1',
						initialRequestBoundary: 'requestStart',
						observationRequestId: 'request-1',
						observationBoundary: 'requestStart',
						deltaModifiedCount: 10,
						modifiedCount: 10,
					},
					{
						recordKind: 'requestCharacterSurvivalSnapshot',
						trackingEpoch: 4,
						initialRequestId: 'request-1',
						initialRequestBoundary: 'requestStart',
						observationRequestId: 'request-1',
						observationBoundary: 'requestEnd',
						deltaModifiedCount: 14,
						modifiedCount: 12,
					},
					{
						recordKind: 'requestCharacterSurvivalSnapshot',
						trackingEpoch: 5,
						initialRequestId: 'request-2',
						initialRequestBoundary: 'requestStart',
						observationRequestId: 'request-2',
						observationBoundary: 'requestStart',
						deltaModifiedCount: 0,
						modifiedCount: 0,
					},
				]
			);
		} finally {
			if (previousValue === undefined) {
				delete process.env[environmentVariable];
			} else {
				process.env[environmentVariable] = previousValue;
			}
		}
	});
});

function diff(from: string, to: string, before: string, after: string): IRequestRepositoryDiff {
	return {
		from,
		to,
		files: [computeRequestDiffFile('file:///repo/file.txt', 'file:///repo/file.txt', before, after)],
		errors: [],
	};
}

function observationShape(observation: {
	schemaVersion: number;
	originatingRequestId: string;
	observationRequestId: string;
	baseModel: string | null;
	observationModel: string | null;
	baseStartTimestamp: string;
	baseEndTimestamp: string;
	observationTimestamp: string;
	observationBoundary: string;
	observationIndex: number;
	states?: object;
	diffs: { originalRequest: object };
}) {
	const isoTimestamps = [observation.baseStartTimestamp, observation.baseEndTimestamp, observation.observationTimestamp];
	return {
		schemaVersion: observation.schemaVersion,
		originatingRequestId: observation.originatingRequestId,
		observationRequestId: observation.observationRequestId,
		baseModel: observation.baseModel,
		observationModel: observation.observationModel,
		observationBoundary: observation.observationBoundary,
		observationIndex: observation.observationIndex,
		hasIsoTimestamps: isoTimestamps.every(timestamp => new Date(timestamp).toISOString() === timestamp),
		baseTimestampsOrdered: observation.baseStartTimestamp <= observation.baseEndTimestamp,
		indexZeroTimestampMatchesBaseEnd: observation.observationIndex !== 0 || observation.observationTimestamp === observation.baseEndTimestamp,
		hasStates: observation.states !== undefined,
		diffKeys: Object.keys(observation.diffs.originalRequest),
	};
}

function characterObservationShape(observation: {
	recordKind: string;
	trackingEpoch: number;
	initialRequestId: string;
	initialRequestBoundary: string;
	observationRequestId: string;
	observationBoundary: string;
	sources: readonly { deltaModifiedCount: number; modifiedCount: number }[];
}) {
	return {
		recordKind: observation.recordKind,
		trackingEpoch: observation.trackingEpoch,
		initialRequestId: observation.initialRequestId,
		initialRequestBoundary: observation.initialRequestBoundary,
		observationRequestId: observation.observationRequestId,
		observationBoundary: observation.observationBoundary,
		deltaModifiedCount: observation.sources[0]?.deltaModifiedCount ?? 0,
		modifiedCount: observation.sources[0]?.modifiedCount ?? 0,
	};
}

class ObservationLogService extends NullLogService {
	readonly firstObservation = new DeferredPromise<string>();
	readonly secondObservation = new DeferredPromise<string>();

	override info(message: string): void {
		const prefix = '[RequestDiffSurvivalObservation] ';
		if (!message.startsWith(prefix)) {
			return;
		}
		const json = message.slice(prefix.length);
		if (!this.firstObservation.isSettled) {
			this.firstObservation.complete(json);
		} else if (!this.secondObservation.isSettled) {
			this.secondObservation.complete(json);
		}
	}
}

interface IRecordedObservation {
	readonly schemaVersion: number;
	readonly complete: boolean;
	readonly originatingRequestId: string;
	readonly originalRequestUsedEditTool: boolean | null;
	readonly observationRequestId: string;
	readonly observationIndex: number;
	readonly maximumObservationCount: number;
	readonly isFinalObservation: boolean;
	readonly baseModel: string | null;
	readonly observationModel: string | null;
	readonly baseStartTimestamp: string;
	readonly baseEndTimestamp: string;
	readonly observationTimestamp: string;
	readonly observationBoundary: string;
	readonly diffs: { readonly originalRequest: object };
}

function createStateManager(provider = 'copilotcli'): AgentHostStateManager {
	const manager = sinon.createStubInstance(AgentHostStateManager);
	manager.getSessionState.returns({
		...createSessionState({ resource: 'session', provider, title: '', status: SessionStatus.Idle, createdAt: '', modifiedAt: '' }),
		turns: [],
	});
	return manager as unknown as AgentHostStateManager;
}

interface IRecordedCharacterObservation extends IRecordedObservation {
	readonly unit: string;
	readonly complete: boolean;
	readonly survival: IRequestDiffSurvivalMetric;
	readonly diffs: {
		readonly originalRequest: IRequestCharacterRepositoryDiff;
		readonly baselineToLatest: IRequestCharacterRepositoryDiff;
		readonly requestResultToLatest: IRequestCharacterRepositoryDiff;
	};
}

class RecordingObservationLogService extends NullLogService {
	readonly observations: IRecordedObservation[] = [];
	readonly characterObservations: IRecordedCharacterObservation[] = [];
	private readonly _requestEnds = new Map<string, DeferredPromise<void>>();

	whenRequestEnds(requestId: string): Promise<void> {
		const ended = new DeferredPromise<void>();
		this._requestEnds.set(requestId, ended);
		return ended.p;
	}

	override info(message: string): void {
		const characterPrefix = '[RequestCharacterDiffSurvivalObservation] ';
		if (message.startsWith(characterPrefix)) {
			this.characterObservations.push(JSON.parse(message.slice(characterPrefix.length)));
			return;
		}
		const prefix = '[RequestDiffSurvivalObservation] ';
		if (!message.startsWith(prefix)) {
			return;
		}
		const observation: IRecordedObservation = JSON.parse(message.slice(prefix.length));
		this.observations.push(observation);
		if (observation.observationIndex === 0) {
			this._requestEnds.get(observation.originatingRequestId)?.complete();
			this._requestEnds.delete(observation.originatingRequestId);
		}
	}
}

class CharacterObservationLogService extends NullLogService {
	readonly observations = [new DeferredPromise<string>(), new DeferredPromise<string>(), new DeferredPromise<string>()];

	override info(message: string): void {
		const prefix = '[RequestCharacterSurvivalSnapshot] ';
		if (!message.startsWith(prefix)) {
			return;
		}
		this.observations.find(observation => !observation.isSettled)?.complete(message.slice(prefix.length));
	}
}

class SnapshotAgentEditAttributionService extends NullAgentEditAttributionService {
	private _snapshotIndex = 0;

	override async snapshot() {
		const snapshots = [
			{ trackingEpoch: 4, deltaModifiedCount: 10, modifiedCount: 10 },
			{ trackingEpoch: 4, deltaModifiedCount: 14, modifiedCount: 12 },
			{ trackingEpoch: 5, deltaModifiedCount: 0, modifiedCount: 0 },
		] as const;
		const snapshot = snapshots[this._snapshotIndex++];
		return {
			trackingEpoch: snapshot.trackingEpoch,
			sources: snapshot.deltaModifiedCount === 0 ? [] : [{
				sourceKey: 'source:Chat.applyEdits-$modelId:kimi-k3-$harness:copilotcli-$origin:agentHost',
				modelId: 'kimi-k3',
				deltaModifiedCount: snapshot.deltaModifiedCount,
				modifiedCount: snapshot.modifiedCount,
			}],
		};
	}
}

type MementoSegment = string | boolean | number;

class TestContributionContext implements IAgentHostChatContributionContext {
	readonly contributionId = RequestDiffSurvivalContribution.id;
	private readonly _values = new Map<string, ISettableObservable<unknown>>();

	memento<T, TExtra extends readonly MementoSegment[]>(
		key: IChatMementoKey<T, TExtra> | ISessionMementoKey<T, TExtra>,
		resource: ProtocolURI,
		...extra: TExtra
	): ISettableObservable<T> {
		const identity = JSON.stringify([key.scope, key.debugName, resource, ...extra]);
		const existing = this._values.get(identity);
		if (existing) {
			return existing as ISettableObservable<T>;
		}
		const value = observableValue(this, key.create());
		this._values.set(identity, value as ISettableObservable<unknown>);
		return value;
	}

	deleteMemento<T, TExtra extends readonly MementoSegment[]>(
		key: IChatMementoKey<T, TExtra> | ISessionMementoKey<T, TExtra>,
		resource: ProtocolURI,
		...extra: TExtra
	): void {
		this._values.delete(JSON.stringify([key.scope, key.debugName, resource, ...extra]));
	}
}
