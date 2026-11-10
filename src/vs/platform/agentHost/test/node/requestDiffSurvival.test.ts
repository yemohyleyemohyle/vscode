/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import sinon from 'sinon';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { LcsDiff } from '../../../../base/common/diff/diff.js';
import { observableValue, type ISettableObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IAgentHostCheckpointService, NULL_CHECKPOINT_SERVICE } from '../../common/agentHostCheckpointService.js';
import type { IAgentHostChatContributionContext, IChatMementoKey, ISessionMementoKey } from '../../common/agentHostChatContributionsService.js';
import { IAgentHostGitService } from '../../common/agentHostGitService.js';
import { createSessionState, MessageKind, SessionStatus, ToolCallCancellationReason, type URI as ProtocolURI } from '../../common/state/sessionState.js';
import { ActionType, type ChatAction } from '../../common/state/sessionActions.js';
import { AgentHostStateManager } from '../../node/agentHostStateManager.js';
import { RequestDiffSurvivalContribution, RequestDiffSurvivalExpiryScheduler } from '../../node/chatContributions/requestDiffSurvival/requestDiffSurvivalContribution.js';
import { RequestDiffSurvivalBudgetError, RequestDiffSurvivalInputBudget, requestDiffSurvivalLimits } from '../../node/chatContributions/requestDiffSurvival/requestDiffSurvivalLimits.js';
import { RequestDiffSurvivalCostObservation, type IRequestDiffSurvivalSizeDetails } from '../../node/chatContributions/requestDiffSurvival/requestDiffSurvivalCost.js';
import { createNoopGitService } from '../common/sessionTestHelpers.js';
import { type computeRequestCharacterDiffSurvivalMetric, type IRequestCharacterRepositoryDiff } from '../../node/chatContributions/requestDiffSurvival/requestCharacterDiffSurvival.js';

suite('Agent Host Request Diff Survival', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	teardown(() => sinon.restore());

	function createStateManager(provider = 'copilotcli'): AgentHostStateManager {
		const manager = disposables.add(new AgentHostStateManager(new NullLogService()));
		sinon.stub(manager, 'getSessionState').returns({
			...createSessionState({ resource: 'session', provider, title: '', status: SessionStatus.Idle, createdAt: '', modifiedAt: '' }),
			turns: [],
		});
		return manager;
	}

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
					createNoopGitService(), createStateManager(scenario.provider),
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
					{ request: 'later', used: scenario.provider === 'codex' ? null : false, otherSourceFlag: false },
				];
				assert.deepStrictEqual(project(log.characterObservations), expected);
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
					createNoopGitService(), createStateManager(),
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
					{ base: scenario.expected, observing: 'later-model', origin: 'base', request: 'later', boundary: 'requestEnd' },
					{ base: 'later-model', observing: 'later-model', origin: 'later', request: 'later', boundary: 'requestEnd' },
				];
				assert.deepStrictEqual(project(logService.characterObservations), expected);
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
			const contribution = disposables.add(new RequestDiffSurvivalContribution(
				new TestContributionContext(),
				logService,
				checkpointService,
				gitService,
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
			contribution.onTurnEnd({ session, channel: chat, turnId: 'later-request', reason: { kind: 'success' } });
			const laterObservation = JSON.parse(await logService.secondObservation.p);

			assert.deepStrictEqual({
				base: observationShape(baseObservation),
				later: observationShape(laterObservation),
				baseTimestampsMatchAcrossObservations:
					baseObservation.baseStartTimestamp === laterObservation.baseStartTimestamp
					&& baseObservation.baseEndTimestamp === laterObservation.baseEndTimestamp,
			}, {
				base: {
					schemaVersion: 4,
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
					schemaVersion: 4,
					originatingRequestId: 'base-request',
					observationRequestId: 'later-request',
					baseModel: 'kimi-k3',
					observationModel: 'gpt-5',
					observationBoundary: 'requestEnd',
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

	test('observes only request ends and stops each originating request after ten follow-ups', async () => {
		const previousValue = process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG;
		process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG = '1';
		try {
			const repository = URI.file('/repo');
			const logService = new RecordingObservationLogService();
			let comparisonCount = 0;
			const startOnlyWork: { records: number; comparisons: number }[] = [];
			const contribution = disposables.add(new RequestDiffSurvivalContribution(
				new TestContributionContext(),
				logService,
				{
					...NULL_CHECKPOINT_SERVICE,
					getTurnStartCheckpointState: async (_session, _chat, turnId) => [{ repository, tree: `${turnId}-start` }],
					waitForTurnCheckpointPair: async (_session, _chat, turnId) => ({ parent: `${turnId}-start`, current: `${turnId}-end` }),
				},
				{
					...createNoopGitService(),
					computeFileDiffsBetweenRefs: async () => {
						comparisonCount++;
						return [];
					},
				},
				createStateManager(),
			));
			for (let index = 0; index < 12; index++) {
				const turnId = `request-${index}`;
				const ended = logService.whenRequestEnds(turnId);
				const recordsBeforeStart = logService.characterObservations.length;
				const comparisonsBeforeStart = comparisonCount;
				contribution.onOutgoingTurn({
					session: 'ahp-session:/session',
					chat: 'ahp-chat:/chat',
					turnId,
					message: { text: 'request', origin: { kind: MessageKind.User } },
				});
				await timeout(0);
				startOnlyWork.push({
					records: logService.characterObservations.length - recordsBeforeStart,
					comparisons: comparisonCount - comparisonsBeforeStart,
				});
				contribution.onTurnEnd({ session: 'ahp-session:/session', channel: 'ahp-chat:/chat', turnId, reason: { kind: 'success' } });
				await ended;
			}
			assert.deepStrictEqual({
				startOnlyWork,
				base: logService.characterObservations.filter(observation => observation.originatingRequestId === 'request-0').map(observation => ({
					index: observation.observationIndex,
					maximum: observation.maximumObservationCount,
					followUps: observation.maximumFollowUpCount,
					final: observation.isFinalObservation,
					boundary: observation.observationBoundary,
					ratio: observation.survival.ratio,
				})),
				lastBoundaryRecords: logService.characterObservations.filter(observation => observation.observationRequestId === 'request-11').length,
			}, {
				startOnlyWork: Array.from({ length: 12 }, () => ({ records: 0, comparisons: 0 })),
				base: Array.from({ length: 11 }, (_, index) => ({
					index, maximum: 11, followUps: 10, final: index === 10, boundary: 'requestEnd', ratio: null,
				})),
				lastBoundaryRecords: 11,
			});
		} finally {
			if (previousValue === undefined) {
				delete process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG;
			} else {
				process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG = previousValue;
			}
		}
	});

	test('keeps follow-up horizons separate between chats', async () => {
		const previousValue = process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG;
		process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG = '1';
		try {
			const repository = URI.file('/repo');
			const log = new RecordingObservationLogService();
			const contribution = disposables.add(new RequestDiffSurvivalContribution(
				new TestContributionContext(), log,
				{
					...NULL_CHECKPOINT_SERVICE,
					getTurnStartCheckpointState: async () => [{ repository, tree: 'before' }],
					waitForTurnCheckpointPair: async () => ({ parent: 'before', current: 'after' }),
				},
				{ ...createNoopGitService(), computeFileDiffsBetweenRefs: async () => [] },
				createStateManager(),
			));
			for (const [index, chat] of ['first', 'second', 'first'].entries()) {
				const turnId = `request-${index}`;
				const ended = log.whenRequestEnds(turnId);
				contribution.onOutgoingTurn({ session: 'session', chat, turnId, message: { text: 'request', origin: { kind: MessageKind.User } } });
				contribution.onTurnEnd({ session: 'session', channel: chat, turnId, reason: { kind: 'success' } });
				await ended;
			}
			assert.deepStrictEqual(log.characterObservations.map(record => ({
				chat: record.chatId, origin: record.originatingRequestId, request: record.observationRequestId, index: record.observationIndex,
			})), [
				{ chat: 'first', origin: 'request-0', request: 'request-0', index: 0 },
				{ chat: 'second', origin: 'request-1', request: 'request-1', index: 0 },
				{ chat: 'first', origin: 'request-0', request: 'request-2', index: 1 },
				{ chat: 'first', origin: 'request-2', request: 'request-2', index: 0 },
			]);
		} finally {
			if (previousValue === undefined) {
				delete process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG;
			} else {
				process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG = previousValue;
			}
		}
	});

	test('logs only character diffs and reports incomplete calculations explicitly', async () => {
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
					getBlobSize: async (_repository, ref) => VSBuffer.fromString(ref === 'before' ? 'base' : 'base中文').byteLength,
				},
				createStateManager(),
			));
			const ended = logService.whenRequestEnds('request');
			contribution.onOutgoingTurn({ session: 'session', chat: 'chat', turnId: 'request', message: { text: 'request', origin: { kind: MessageKind.User }, model: { id: 'model' } } });
			contribution.onTurnEnd({ session: 'session', channel: 'chat', turnId: 'request', reason: { kind: 'success' } });
			await ended;
			const character = logService.characterObservations[0];
			assert.deepStrictEqual({
				blobReads,
				unit: character.unit,
				complete: character.complete,
				survival: character.survival,
				ranges: character.diffs!.originalRequest.files[0].plus,
			}, {
				blobReads: 2,
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
				const character = logService.characterObservations.find(record => record.originatingRequestId === requestId && record.observationIndex === 0)!;
				return { characterComplete: character.complete, hasCharacterErrors: character.diffs!.originalRequest.errors.length > 0 };
			}), [
				{ characterComplete: false, hasCharacterErrors: true },
				{ characterComplete: false, hasCharacterErrors: true },
			]);
		} finally {
			if (previousValue === undefined) {
				delete process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG;
			} else {
				process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG = previousValue;
			}
		}
	});
	suite('budget safeguards', () => {
		let previousEnvironmentValue: string | undefined;
		setup(() => {
			previousEnvironmentValue = process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG;
			process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG = '1';
		});
		teardown(() => {
			if (previousEnvironmentValue === undefined) {
				delete process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG;
			} else {
				process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG = previousEnvironmentValue;
			}
		});

		function fixture(repositories: readonly URI[] = [URI.file('/repo')], lifetime = false) {
			const context = new TestContributionContext();
			const log = new RecordingObservationLogService();
			const git = {
				...createNoopGitService(),
				computeFileDiffsBetweenRefs: sinon.stub().resolves([{
					after: { uri: 'file:///repo/file', content: { uri: 'after' } },
					diff: { added: 1, removed: 0 },
				}]),
				getBlobSize: sinon.stub().resolves(2),
				showBlob: sinon.stub().resolves(VSBuffer.fromString('ab')),
			};
			const checkpoint = {
				...NULL_CHECKPOINT_SERVICE,
				getTurnStartCheckpointState: async (_session, _chat, turnId) => repositories.map(repository => ({ repository, tree: `${turnId}-start` })),
				waitForTurnCheckpointPair: async (_session, _chat, turnId) => ({ parent: `${turnId}-start`, current: `${turnId}-end` }),
			} satisfies IAgentHostCheckpointService;
			const Contribution = lifetime ? TestLifetimeContribution : RequestDiffSurvivalContribution;
			const contribution = disposables.add(new Contribution(context, log, checkpoint, git, createStateManager()));
			const begin = (turnId: string, chat = 'chat') => {
				contribution.onOutgoingTurn({ session: 'session', chat, turnId, message: { text: 'request', origin: { kind: MessageKind.User } } });
				contribution.onTurnEnd({ session: 'session', channel: chat, turnId, reason: { kind: 'success' } });
			};
			const end = async (turnId: string, chat = 'chat') => {
				const ended = log.whenRequestEnds(turnId);
				begin(turnId, chat);
				await ended;
			};
			return {
				context, log, git, checkpoint, contribution, begin, end,
				clock: contribution instanceof TestLifetimeContribution ? contribution.clock : undefined,
			};
		}

		function terminalShape(record: IRecordedCharacterObservation) {
			return {
				status: record.status, complete: record.complete, final: record.isFinalObservation,
				flags: [record.fileInputBudgetExceeded, record.observationInputBudgetExceeded, record.retainedDiffBudgetExceeded],
				survival: Object.values(record.survival), hasDiffs: Object.hasOwn(record, 'diffs'),
			};
		}

		const terminal = {
			status: 'budgetExceeded', complete: false, final: true,
			survival: [-1, -1, -1, -1, -1, -1, -1], hasDiffs: false,
		};

		suite('tracker lifetime', () => {
			function lifetimeFixture() {
				const f = fixture([URI.file('/repo')], true);
				assert.ok(f.clock);
				const clock = f.clock;
				const capture = sinon.stub().resolves('expiry-tree');
				f.git.captureWorkingTreeAsTree = capture;
				const send = (turnId: string, chat = 'chat', repository = URI.file('/repo')) => f.contribution.onOutgoingTurn({
					session: 'session', chat, turnId, workingDirectories: [repository],
					message: { text: 'request', origin: { kind: MessageKind.User } },
				});
				return { ...f, clock, capture, send };
			}

			function expiryShape(record: IRecordedCharacterObservation) {
				return {
					index: record.observationIndex, request: record.observationRequestId, boundary: record.observationBoundary,
					final: record.isFinalObservation, status: record.status, reason: record.terminalReason,
					unavailable: record.unavailableReason, complete: record.complete, ratio: record.survival.ratio,
				};
			}

			test('uses centralized production durations and expires at the exact idle deadline without another request', async () => {
				const f = lifetimeFixture();
				await f.end('base');
				const expired = f.log.whenExpires('base');
				f.clock.advance(requestDiffSurvivalLimits.idleExpiryMs - 1);
				assert.deepStrictEqual({
					durations: [requestDiffSurvivalLimits.idleExpiryMs, requestDiffSurvivalLimits.maximumTrackerAgeMs],
					records: f.log.characterObservations.length, captures: f.capture.callCount,
				}, { durations: [3_600_000, 86_400_000], records: 1, captures: 0 });
				f.clock.advance(1);
				await expired;
				const record = f.log.characterObservations[1];
				const comparisonRefs = f.git.computeFileDiffsBetweenRefs.getCalls().slice(1).map(call => call.args[1]);
				assert.deepStrictEqual({
					record: expiryShape(record), captures: f.capture.callCount,
					refs: comparisonRefs.map(ref => [ref.fromRef, ref.toRef]),
					releases: f.log.sizeObservations.filter(record => record.reason === 'idleExpired').map(record => ({
						index: record.observationIndex, tracker: record.trackerEstimatedRetainedBytes, host: record.hostEstimatedRetainedBytes,
					})),
				}, {
					record: {
						index: 1, request: 'base', boundary: 'expiry', final: true, status: 'measured',
						reason: 'idleExpired', unavailable: undefined, complete: true, ratio: 1
					},
					captures: 1, refs: [['base-start', 'expiry-tree'], ['base-end', 'expiry-tree']],
					releases: [{ index: 1, tracker: 0, host: 0 }],
				});
				f.clock.advance(requestDiffSurvivalLimits.maximumTrackerAgeMs);
				await f.end('later');
				assert.deepStrictEqual(f.log.characterObservations.filter(record => record.originatingRequestId === 'base').length, 2);
			});

			test('suspends idle expiry during a running request and resets it on request end', async () => {
				const f = lifetimeFixture();
				await f.end('base');
				f.clock.advance(requestDiffSurvivalLimits.idleExpiryMs - 1);
				f.send('running');
				f.clock.advance(requestDiffSurvivalLimits.idleExpiryMs + 1);
				assert.deepStrictEqual(f.capture.callCount, 0);
				const ended = f.log.whenRequestEnds('running');
				f.contribution.onTurnEnd({ session: 'session', channel: 'chat', turnId: 'running', reason: { kind: 'success' } });
				await ended;
				f.clock.advance(requestDiffSurvivalLimits.idleExpiryMs - 1);
				assert.deepStrictEqual(f.capture.callCount, 0);
				const expired = f.log.whenExpires('base');
				f.clock.advance(1);
				await expired;
				assert.deepStrictEqual(f.log.characterObservations.filter(record => record.originatingRequestId === 'base').map(record => ({
					index: record.observationIndex, boundary: record.observationBoundary,
				})), [{ index: 0, boundary: 'requestEnd' }, { index: 1, boundary: 'requestEnd' }, { index: 2, boundary: 'expiry' }]);
			});

			test('fresh expiry state measures edits removed after the last request rather than reusing its 100% result', async () => {
				const f = lifetimeFixture();
				await f.end('base');
				f.git.computeFileDiffsBetweenRefs.callsFake(async (_repository: URI, options: { fromRef: string }) =>
					options.fromRef === 'base-start' ? [] : [{
						before: { uri: 'file:///repo/file', content: { uri: 'before' } }, diff: { added: 0, removed: 2 },
					}]);
				const expired = f.log.whenExpires('base');
				f.clock.advance(requestDiffSurvivalLimits.idleExpiryMs);
				await expired;
				assert.deepStrictEqual(f.log.characterObservations.map(record => ({
					status: record.status, complete: record.complete, ratio: record.survival.ratio,
					surviving: record.survival.totalSurviving,
				})), [
					{ status: 'measured', complete: true, ratio: 1, surviving: 2 },
					{ status: 'measured', complete: true, ratio: 0, surviving: 0 },
				]);
			});

			test('expiry does not wait behind a blocked queued checkpoint for another request', async () => {
				const f = lifetimeFixture();
				await f.end('base');
				const started = new DeferredPromise<void>();
				const checkpoint = new DeferredPromise<void>();
				f.checkpoint.getTurnStartCheckpointState = async () => {
					started.complete();
					await checkpoint.p;
					return [{ repository: URI.file('/repo'), tree: 'queued-start' }];
				};
				f.begin('queued');
				await started.p;
				const expired = f.log.whenExpires('base');
				f.clock.advance(requestDiffSurvivalLimits.idleExpiryMs);
				await expired;
				assert.deepStrictEqual({
					records: f.log.characterObservations.filter(record => record.originatingRequestId === 'base').length,
					captures: f.capture.callCount,
				}, { records: 2, captures: 1 });
				checkpoint.complete();
				await timeout(0);
			});

			test('a terminal log failure is reported without retrying the terminal or leaking retention', async () => {
				const f = lifetimeFixture();
				await f.end('base');
				const warning = new DeferredPromise<void>();
				sinon.stub(f.log, 'warn').callsFake(() => { warning.complete(); });
				const info = sinon.stub(f.log, 'info').callThrough();
				info.withArgs(sinon.match((message: string) => message.startsWith('[RequestCharacterDiffSurvivalObservation] ')))
					.throws(new Error('terminal log failed'));
				f.clock.advance(requestDiffSurvivalLimits.idleExpiryMs);
				await warning.p;
				assert.deepStrictEqual({
					attempts: info.getCalls().filter(call => call.args[0].startsWith('[RequestCharacterDiffSurvivalObservation] ')).length,
					host: f.log.sizeObservations.at(-1)?.hostEstimatedRetainedBytes, scheduled: f.clock.isScheduled(),
				}, { attempts: 1, host: 0, scheduled: false });
			});

			test('maximum age wins over idle expiry when both are overdue', async () => {
				const f = lifetimeFixture();
				await f.end('base');
				const expired = f.log.whenExpires('base');
				f.clock.advance(requestDiffSurvivalLimits.maximumTrackerAgeMs);
				await expired;
				assert.deepStrictEqual(f.log.characterObservations[1].terminalReason, 'maximumAgeExceeded');
			});

			test('maximum age is not extended by active turns and does not wait for a quiet window', async () => {
				const f = lifetimeFixture();
				await f.end('base');
				f.send('running');
				f.clock.advance(requestDiffSurvivalLimits.maximumTrackerAgeMs - 1);
				assert.deepStrictEqual(f.log.characterObservations.length, 1);
				const expired = f.log.whenExpires('base');
				f.clock.advance(1);
				await expired;
				assert.deepStrictEqual({
					reason: f.log.characterObservations[1].terminalReason,
					unavailable: f.log.characterObservations[1].unavailableReason,
					ratio: f.log.characterObservations[1].survival.ratio, captures: f.capture.callCount,
				}, { reason: 'maximumAgeExceeded', unavailable: 'repositoryBusy', ratio: -1, captures: 0 });
			});

			test('activity in another chat does not reset idle expiry and shared-repository activity prevents capture', async () => {
				const f = lifetimeFixture();
				await f.end('base');
				f.clock.advance(requestDiffSurvivalLimits.idleExpiryMs - 1);
				f.send('other', 'other-chat');
				const expired = f.log.whenExpires('base');
				f.clock.advance(1);
				await expired;
				assert.deepStrictEqual({
					reason: f.log.characterObservations[1].terminalReason,
					unavailable: f.log.characterObservations[1].unavailableReason, captures: f.capture.callCount,
					scheduled: f.clock.isScheduled(),
				}, { reason: 'idleExpired', unavailable: 'repositoryBusy', captures: 0, scheduled: false });
			});

			test('known activity in an unrelated repository does not prevent expiry capture', async () => {
				const f = lifetimeFixture();
				await f.end('base');
				f.send('other', 'other-chat', URI.file('/other-repo'));
				const expired = f.log.whenExpires('base');
				f.clock.advance(requestDiffSurvivalLimits.idleExpiryMs);
				await expired;
				assert.deepStrictEqual({
					status: f.log.characterObservations[1].status, captures: f.capture.callCount,
				}, { status: 'measured', captures: 1 });
			});

			for (const failure of ['missing', 'throwing'] as const) {
				test(`logs an unavailable terminal and releases retention after ${failure} fresh capture`, async () => {
					const f = lifetimeFixture();
					await f.end('base');
					if (failure === 'missing') {
						f.capture.resolves(undefined);
					} else {
						f.capture.rejects(new Error('capture failed'));
					}
					const expired = f.log.whenExpires('base');
					f.clock.advance(requestDiffSurvivalLimits.idleExpiryMs);
					await expired;
					assert.deepStrictEqual({
						status: f.log.characterObservations[1].status, unavailable: f.log.characterObservations[1].unavailableReason,
						survival: Object.values(f.log.characterObservations[1].survival),
						diffs: f.log.characterObservations[1].diffs,
						host: f.log.sizeObservations.at(-1)?.hostEstimatedRetainedBytes, scheduled: f.clock.isScheduled(),
					}, {
						status: 'unavailable', unavailable: 'captureFailed', survival: [-1, -1, -1, -1, -1, -1, -1],
						diffs: undefined, host: 0, scheduled: false
					});
				});
			}

			test('an expiry comparison budget violation preserves both expiry and budget reasons and stops further computation', async () => {
				const f = lifetimeFixture();
				await f.end('base');
				const reads = f.git.showBlob.callCount;
				f.git.getBlobSize.resolves(requestDiffSurvivalLimits.maximumFileInputBytes + 1);
				const expired = f.log.whenExpires('base');
				f.clock.advance(requestDiffSurvivalLimits.idleExpiryMs);
				await expired;
				assert.deepStrictEqual({
					record: terminalShape(f.log.characterObservations[1]),
					reason: f.log.characterObservations[1].terminalReason,
					reads: f.git.showBlob.callCount - reads, comparisons: f.git.computeFileDiffsBetweenRefs.callCount,
				}, { record: { ...terminal, flags: [1, 0, 0] }, reason: 'idleExpired', reads: 0, comparisons: 2 });
			});

			test('incomplete final comparisons are unavailable, never valid survival loss', async () => {
				const f = lifetimeFixture();
				await f.end('base');
				f.git.computeFileDiffsBetweenRefs.resolves(undefined);
				const expired = f.log.whenExpires('base');
				f.clock.advance(requestDiffSurvivalLimits.idleExpiryMs);
				await expired;
				assert.deepStrictEqual({
					status: f.log.characterObservations[1].status, unavailable: f.log.characterObservations[1].unavailableReason,
					ratio: f.log.characterObservations[1].survival.ratio, complete: f.log.characterObservations[1].complete,
				}, { status: 'unavailable', unavailable: 'computationFailed', ratio: -1, complete: false });
			});

			test('activity starting and ending during capture invalidates that capture', async () => {
				const f = lifetimeFixture();
				await f.end('base');
				const started = new DeferredPromise<void>();
				const capture = new DeferredPromise<string>();
				f.capture.callsFake(() => { started.complete(); return capture.p; });
				const expired = f.log.whenExpires('base');
				f.clock.advance(requestDiffSurvivalLimits.idleExpiryMs);
				await started.p;
				f.send('race');
				f.contribution.onTurnEnd({ session: 'session', channel: 'chat', turnId: 'race', reason: { kind: 'cancelled' } });
				capture.complete('racing-tree');
				await expired;
				assert.deepStrictEqual({
					status: f.log.characterObservations[1].status, unavailable: f.log.characterObservations[1].unavailableReason,
				}, { status: 'unavailable', unavailable: 'repositoryActivity' });
				await timeout(0);
			});

			test('queued initial computation uses the originating request-end age, not completion time', async () => {
				const f = lifetimeFixture();
				const start = new DeferredPromise<void>();
				f.checkpoint.getTurnStartCheckpointState = async () => {
					await start.p;
					return [{ repository: URI.file('/repo'), tree: 'before' }];
				};
				f.begin('base');
				f.clock.advance(requestDiffSurvivalLimits.maximumTrackerAgeMs);
				const expired = f.log.whenExpires('base');
				start.complete();
				await expired;
				assert.deepStrictEqual({
					count: f.log.characterObservations.length, index: f.log.characterObservations[0].observationIndex,
					reason: f.log.characterObservations[0].terminalReason,
					unavailable: f.log.characterObservations[0].unavailableReason,
					computations: f.git.computeFileDiffsBetweenRefs.callCount,
				}, { count: 1, index: 0, reason: 'maximumAgeExceeded', unavailable: 'initialObservationIncomplete', computations: 0 });
			});

			test('expiry during an in-flight observation releases immediately and prevents a later ordinary record', async () => {
				const f = lifetimeFixture();
				await f.end('base');
				const started = new DeferredPromise<void>();
				const diff = new DeferredPromise<undefined>();
				f.git.computeFileDiffsBetweenRefs.callsFake(() => { started.complete(); return diff.p; });
				f.begin('follow-up');
				await started.p;
				const expired = f.log.whenExpires('base');
				f.clock.advance(requestDiffSurvivalLimits.maximumTrackerAgeMs);
				await expired;
				diff.complete(undefined);
				await timeout(0);
				assert.deepStrictEqual({
					records: f.log.characterObservations.filter(record => record.originatingRequestId === 'base').map(record => record.observationBoundary),
					unavailable: f.log.characterObservations[1].unavailableReason,
					releases: f.log.sizeObservations.filter(record => record.originatingRequestId === 'base' && record.phase === 'release').length,
				}, { records: ['requestEnd', 'expiry'], unavailable: 'observationInProgress', releases: 1 });
			});

			test('the ordinary ten-follow-up horizon cancels expiry for that origin', async () => {
				const f = lifetimeFixture();
				await f.end('base');
				for (let index = 1; index <= requestDiffSurvivalLimits.maximumFollowUpCount; index++) {
					await f.end(`follow-up-${index}`);
				}
				f.clock.advance(requestDiffSurvivalLimits.idleExpiryMs);
				await timeout(0);
				assert.deepStrictEqual(f.log.characterObservations.filter(record => record.originatingRequestId === 'base').map(record => ({
					index: record.observationIndex, boundary: record.observationBoundary, final: record.isFinalObservation,
				})), Array.from({ length: 11 }, (_, index) => ({ index, boundary: 'requestEnd', final: index === 10 })));
			});

			for (const disposal of ['chat', 'contribution', 'capturing'] as const) {
				test(`${disposal} disposal cancels scheduled expiry and never starts new Git work`, async () => {
					const f = lifetimeFixture();
					await f.end('base');
					const started = new DeferredPromise<void>();
					const capture = new DeferredPromise<string>();
					if (disposal === 'capturing') {
						f.capture.callsFake(() => { started.complete(); return capture.p; });
						f.clock.advance(requestDiffSurvivalLimits.idleExpiryMs);
						await started.p;
					}
					if (disposal === 'contribution') {
						f.contribution.dispose();
					} else {
						f.context.evict('chat');
					}
					capture.complete('after-disposal');
					f.clock.advance(requestDiffSurvivalLimits.maximumTrackerAgeMs);
					await timeout(0);
					assert.deepStrictEqual({
						records: f.log.characterObservations.length, captures: f.capture.callCount,
						scheduled: f.clock.isScheduled(), host: f.log.sizeObservations.at(-1)?.hostEstimatedRetainedBytes,
					}, { records: 1, captures: disposal === 'capturing' ? 1 : 0, scheduled: false, host: 0 });
				});
			}
		});

		test('allows the exact production input limits, rejects one byte over, and reports both confirmed violations', () => {
			const budget = new RequestDiffSurvivalInputBudget();
			for (let index = 0; index < 8; index++) {
				budget.consume(512 * 1024);
			}
			assert.throws(() => budget.consume(512 * 1024 + 1), error => {
				assert.ok(error instanceof RequestDiffSurvivalBudgetError);
				assert.deepStrictEqual({
					file: error.fileInputBudgetExceeded, observation: error.observationInputBudgetExceeded,
					retained: error.retainedDiffBudgetExceeded, diagnostics: error.diagnostics,
				}, {
					file: true, observation: true, retained: false,
					diagnostics: { fileInputBytes: 512 * 1024 + 1, observationInputBytes: 4 * 1024 * 1024 + 512 * 1024 + 1 },
				});
				return true;
			});
		});

		test('rejects initial file input before reading blobs or computing character diffs', async () => {
			const f = fixture();
			f.git.getBlobSize.resolves(requestDiffSurvivalLimits.maximumFileInputBytes + 1);
			const lcs = sinon.spy(LcsDiff.prototype, 'ComputeDiff');
			await f.end('oversized');
			assert.deepStrictEqual({
				record: terminalShape(f.log.characterObservations[0]), reads: f.git.showBlob.callCount, computations: lcs.callCount,
			}, { record: { ...terminal, flags: [1, 0, 0] }, reads: 0, computations: 0 });
		});

		test('rejects the first byte past the cumulative observation limit', () => {
			const budget = new RequestDiffSurvivalInputBudget();
			for (let index = 0; index < 8; index++) {
				budget.consume(512 * 1024);
			}
			assert.throws(() => budget.consume(1), error =>
				error instanceof RequestDiffSurvivalBudgetError && !error.fileInputBudgetExceeded && error.observationInputBudgetExceeded
				&& error.diagnostics.observationInputBytes === 4 * 1024 * 1024 + 1);
		});

		test('sums repeated input across both follow-up comparisons and permanently retires the origin', async () => {
			sinon.stub(requestDiffSurvivalLimits, 'maximumFileInputBytes').value(2);
			sinon.stub(requestDiffSurvivalLimits, 'maximumObservationInputBytes').value(3);
			const f = fixture();
			await f.end('base');
			await f.end('later');
			await f.end('last');
			assert.deepStrictEqual({
				base: f.log.characterObservations.filter(record => record.originatingRequestId === 'base').map(record => ({
					index: record.observationIndex, status: record.status,
				})),
				terminal: terminalShape(f.log.characterObservations[1]),
				diagnostics: f.log.characterObservations[1].budgetDiagnostics,
				comparisons: f.git.computeFileDiffsBetweenRefs.callCount,
				reads: f.git.showBlob.callCount,
			}, {
				base: [{ index: 0, status: 'measured' }, { index: 1, status: 'budgetExceeded' }],
				terminal: { ...terminal, flags: [0, 1, 0] },
				diagnostics: { fileInputBytes: 2, observationInputBytes: 4 },
				comparisons: 7, reads: 5,
			});
		});

		test('allows combined before/after input exactly at the file limit', async () => {
			sinon.stub(requestDiffSurvivalLimits, 'maximumFileInputBytes').value(4);
			sinon.stub(requestDiffSurvivalLimits, 'maximumObservationInputBytes').value(4);
			const f = fixture();
			f.git.computeFileDiffsBetweenRefs.resolves([{
				before: { uri: 'file:///repo/file', content: { uri: 'before' } },
				after: { uri: 'file:///repo/file', content: { uri: 'after' } },
				diff: { added: 1, removed: 1 },
			}]);
			await f.end('exact');
			assert.deepStrictEqual({
				status: f.log.characterObservations[0].status, complete: f.log.characterObservations[0].complete, reads: f.git.showBlob.callCount,
			}, { status: 'measured', complete: true, reads: 2 });
		});

		test('shares retained admission across chats, accepts equality, and releases on eviction', async () => {
			const path = `${URI.file('/repo').toString()}#file`;
			const retainedBytes = 256 + 256 + 4 + 2 * path.length + 128 + 2 * (path.length + 2);
			sinon.stub(requestDiffSurvivalLimits, 'maximumRetainedDiffBytes').value(retainedBytes);
			const f = fixture();
			await f.end('first', 'first-chat');
			await f.end('rejected', 'second-chat');
			f.context.evict('first-chat');
			await f.end('admitted', 'third-chat');
			assert.deepStrictEqual({
				statuses: f.log.characterObservations.map(record => record.status),
				rejected: terminalShape(f.log.characterObservations[1]),
			}, {
				statuses: ['measured', 'budgetExceeded', 'measured'],
				rejected: { ...terminal, flags: [0, 0, 1] },
			});
		});

		test('rolls back partial retained construction when reserving a change exceeds the limit', async () => {
			const path = `${URI.file('/repo').toString()}#file`;
			const retainedBytes = 256 + 256 + 4 + 2 * path.length + 128 + 2 * (path.length + 2);
			sinon.stub(requestDiffSurvivalLimits, 'maximumRetainedDiffBytes').value(retainedBytes - 1);
			const f = fixture();
			await f.end('rejected');
			f.git.computeFileDiffsBetweenRefs.resolves([]);
			await f.end('empty', 'another-chat');
			assert.deepStrictEqual({
				statuses: f.log.characterObservations.map(record => record.status),
				rejected: terminalShape(f.log.characterObservations[0]),
				reads: f.git.showBlob.callCount,
				proposed: f.log.characterObservations[0].budgetDiagnostics?.proposedRetainedDiffBytes,
			}, {
				statuses: ['budgetExceeded', 'measured'], rejected: { ...terminal, flags: [0, 0, 1] }, reads: 1,
				proposed: retainedBytes,
			});
		});

		test('concurrent chats reserve against one host-wide counter', async () => {
			const path = `${URI.file('/repo').toString()}#file`;
			sinon.stub(requestDiffSurvivalLimits, 'maximumRetainedDiffBytes').value(256 + 256 + 4 + 2 * path.length + 128 + 2 * (path.length + 2));
			const f = fixture();
			const gate = new DeferredPromise<number>();
			const ready = new DeferredPromise<void>();
			let lookups = 0;
			f.git.getBlobSize.callsFake(() => {
				if (++lookups === 2) {
					ready.complete();
				}
				return gate.p;
			});
			const first = f.end('first', 'one');
			const second = f.end('second', 'two');
			await ready.p;
			await gate.complete(2);
			await Promise.all([first, second]);
			assert.deepStrictEqual(f.log.characterObservations.map(record => record.status).sort(), ['budgetExceeded', 'measured']);
		});

		test('eviction cancels in-flight work, releases reservations and cannot recreate old state', async () => {
			const path = `${URI.file('/repo').toString()}#file`;
			sinon.stub(requestDiffSurvivalLimits, 'maximumRetainedDiffBytes').value(256 + 256 + 4 + 2 * path.length + 128 + 2 * (path.length + 2));
			const f = fixture();
			const gate = new DeferredPromise<VSBuffer>();
			const reading = new DeferredPromise<void>();
			f.git.showBlob.callsFake(() => {
				reading.complete();
				return gate.p;
			});
			f.begin('evicted');
			await reading.p;
			f.begin('queued-before-eviction');
			f.context.evict('chat');
			await gate.complete(VSBuffer.fromString('ab'));
			f.git.showBlob.resolves(VSBuffer.fromString('ab'));
			await f.end('fresh');
			assert.deepStrictEqual(f.log.characterObservations.map(record => ({
				origin: record.originatingRequestId, status: record.status,
			})), [{ origin: 'fresh', status: 'measured' }]);
		});

		test('missing size metadata produces an explicit incomplete observation, never a zero-size fallback', async () => {
			const f = fixture();
			f.git.getBlobSize.resolves(undefined);
			await f.end('missing');
			const record = f.log.characterObservations[0];
			assert.deepStrictEqual({
				status: record.status, complete: record.complete, reads: f.git.showBlob.callCount, errors: record.diffs?.originalRequest.errors,
			}, {
				status: 'measured', complete: false, reads: 0,
				errors: ['Failed to materialize file:///repo/file: Unable to read Git blob size'],
			});
		});

		test('accumulates initial input over files and stops before reading the violating file', async () => {
			sinon.stub(requestDiffSurvivalLimits, 'maximumObservationInputBytes').value(5);
			const f = fixture();
			f.git.computeFileDiffsBetweenRefs.resolves(['one', 'two', 'three'].map(name => ({
				after: { uri: `file:///repo/${name}`, content: { uri: 'after' } },
				diff: { added: 1, removed: 0 },
			})));
			await f.end('multiple-files');
			assert.deepStrictEqual({
				record: terminalShape(f.log.characterObservations[0]), reads: f.git.showBlob.callCount,
				diagnostics: f.log.characterObservations[0].budgetDiagnostics,
			}, {
				record: { ...terminal, flags: [0, 1, 0] }, reads: 2,
				diagnostics: { fileInputBytes: 2, observationInputBytes: 6 },
			});
		});

		test('uses the same observation allowance across repository boundaries', async () => {
			sinon.stub(requestDiffSurvivalLimits, 'maximumObservationInputBytes').value(3);
			const f = fixture([URI.file('/repo'), URI.file('/other-repo')]);
			f.git.computeFileDiffsBetweenRefs.callsFake(async (repository: URI) => [{
				after: { uri: URI.joinPath(repository, 'file').toString(), content: { uri: 'after' } },
				diff: { added: 1, removed: 0 },
			}]);
			await f.end('multiple-repositories');
			assert.deepStrictEqual({
				record: terminalShape(f.log.characterObservations[0]), reads: f.git.showBlob.callCount,
				repositories: f.git.computeFileDiffsBetweenRefs.callCount,
			}, { record: { ...terminal, flags: [0, 1, 0] }, reads: 1, repositories: 2 });
		});

		test('separate compute events reuse survival identity and aggregate two follow-up comparisons', async () => {
			const f = fixture();
			await f.end('base');
			await f.end('later');
			const files = f.log.computeObservations.filter(event => event.phase === 'file');
			const followUp = f.log.computeObservations.find(event => event.originatingRequestId === 'base' && event.observationIndex === 1 && event.phase === 'observation')!;
			assert.deepStrictEqual({
				files: files.map(event => ({
					base: event.originatingRequestId, request: event.observationRequestId, index: event.observationIndex,
					comparison: event.comparisonKind, repository: event.repositoryIndex, file: event.fileIndex,
				})),
				followUpCount: followUp.startedFileCount,
				aggregateMatches: followUp.elapsedMs === files.filter(event => event.originatingRequestId === 'base' && event.observationIndex === 1).reduce((sum, event) => sum + event.elapsedMs!, 0),
				cpuStatuses: [...new Set(files.map(event => event.cpuMeasurementStatus))],
				reuse: f.log.computeObservations.filter(event => event.originatingRequestId === 'base' && event.phase === 'comparison' && event.status === 'reused').map(event => ({
					comparison: event.comparisonKind, index: event.observationIndex, elapsed: event.elapsedMs, cpu: event.cpuTotalMs,
				})),
			}, {
				files: [
					{ base: 'base', request: 'base', index: 0, comparison: 'originalRequest', repository: 0, file: 0 },
					{ base: 'base', request: 'later', index: 1, comparison: 'baselineToLatest', repository: 0, file: 0 },
					{ base: 'base', request: 'later', index: 1, comparison: 'requestResultToLatest', repository: 0, file: 0 },
					{ base: 'later', request: 'later', index: 0, comparison: 'originalRequest', repository: 0, file: 0 },
				],
				followUpCount: 2, aggregateMatches: true,
				cpuStatuses: [typeof process.threadCpuUsage === 'function' ? 'available' : 'unsupported'],
				reuse: [
					{ comparison: 'baselineToLatest', index: 0, elapsed: null, cpu: null },
					{ comparison: 'originalRequest', index: 1, elapsed: null, cpu: null },
				],
			});
		});

		test('size events distinguish accepted from rejected input and retain the originating index', async () => {
			sinon.stub(requestDiffSurvivalLimits, 'maximumObservationInputBytes').value(3);
			const f = fixture();
			await f.end('base');
			await f.end('later');
			const rejected = f.log.sizeObservations.find(event => event.originatingRequestId === 'base' && event.phase === 'budgetRejection')!;
			const notStarted = f.log.computeObservations.find(event => event.originatingRequestId === 'base' && event.observationIndex === 1 && event.phase === 'file' && !event.computationStarted)!;
			assert.deepStrictEqual({
				rejected: {
					base: rejected.originatingRequestId, request: rejected.observationRequestId, index: rejected.observationIndex,
					fileBytes: rejected.fileInputBytes, accepted: rejected.observationInputBytes, proposed: rejected.proposedObservationInputBytes,
				},
				compute: { status: notStarted.status, elapsed: notStarted.elapsedMs, cpu: notStarted.cpuTotalMs },
				release: f.log.sizeObservations.filter(event => event.originatingRequestId === 'base' && event.phase === 'release').map(event => ({
					index: event.observationIndex, reason: event.reason, trackerBytes: event.trackerEstimatedRetainedBytes, hostBytes: event.hostEstimatedRetainedBytes,
				})),
			}, {
				rejected: { base: 'base', request: 'later', index: 1, fileBytes: 2, accepted: 2, proposed: 4 },
				compute: { status: 'budgetRejected', elapsed: null, cpu: null },
				release: [{ index: 1, reason: 'budgetRejected', trackerBytes: 0, hostBytes: 0 }],
			});
		});

		test('retained rejection snapshots precede release and no duplicate release event is emitted', async () => {
			const path = `${URI.file('/repo').toString()}#file`;
			const retainedBytes = 256 + 256 + 4 + 2 * path.length + 128 + 2 * (path.length + 2);
			sinon.stub(requestDiffSurvivalLimits, 'maximumRetainedDiffBytes').value(retainedBytes - 1);
			const f = fixture();
			await f.end('base');
			const rejected = f.log.sizeObservations.find(event => event.phase === 'budgetRejection')!;
			assert.deepStrictEqual({
				beforeRelease: rejected.hostEstimatedRetainedBytes,
				proposed: rejected.proposedHostEstimatedRetainedBytes,
				releases: f.log.sizeObservations.filter(event => event.phase === 'release').map(event => ({
					base: event.originatingRequestId, index: event.observationIndex, hostBytes: event.hostEstimatedRetainedBytes, delta: event.retainedBytesDelta,
				})),
				compute: f.log.computeObservations.filter(event => event.phase === 'file').map(event => ({ status: event.status, started: event.computationStarted })),
			}, {
				beforeRelease: 256 + 256 + 4 + 2 * path.length, proposed: retainedBytes,
				releases: [{ base: 'base', index: 0, hostBytes: 0, delta: -(256 + 256 + 4 + 2 * path.length) }],
				compute: [{ status: 'budgetRejected', started: true }],
			});
		});

		test('eviction logs host-wide release totals using the last associated request/index', async () => {
			const f = fixture();
			await f.end('one', 'one-chat');
			await f.end('two', 'two-chat');
			const admissions = f.log.sizeObservations.filter(event => event.phase === 'admission' && event.status === 'completed');
			const firstBytes = admissions[0].trackerEstimatedRetainedBytes;
			f.context.evict('one-chat');
			f.context.evict('two-chat');
			assert.deepStrictEqual({
				hostAdmissions: admissions.map(event => event.hostEstimatedRetainedBytes),
				releases: f.log.sizeObservations.filter(event => event.phase === 'release').map(event => ({
					base: event.originatingRequestId, index: event.observationIndex, reason: event.reason, host: event.hostEstimatedRetainedBytes, delta: event.retainedBytesDelta,
				})),
			}, {
				hostAdmissions: [firstBytes, 2 * firstBytes],
				releases: [
					{ base: 'one', index: 0, reason: 'stateDisposed', host: firstBytes, delta: -firstBytes },
					{ base: 'two', index: 0, reason: 'stateDisposed', host: 0, delta: -firstBytes },
				],
			});
		});

		test('missing metadata remains unavailable and failed construction rolls back before recording error retention', async () => {
			const f = fixture();
			f.git.getBlobSize.resolves(undefined);
			await f.end('missing');
			const missing = f.log.sizeObservations.find(event => event.phase === 'inputCheck')!;
			const rollbacks = f.log.sizeObservations.filter(event => event.phase === 'rollback');
			assert.deepStrictEqual({
				input: missing.fileInputBytes, accepted: missing.observationInputBytes, status: missing.status,
				compute: f.log.computeObservations.find(event => event.phase === 'file')?.computationStarted,
				rollbacks: rollbacks.map(event => ({ delta: event.retainedBytesDelta, tracker: event.trackerEstimatedRetainedBytes })),
			}, { input: null, accepted: 0, status: 'failed', compute: false, rollbacks: [{ delta: 0, tracker: 256 }] });
		});

		test('failed character computation rolls back file retention before retaining the error record', async () => {
			const f = fixture();
			sinon.stub(LcsDiff.prototype, 'ComputeDiff').throws(new Error('diff failed'));
			await f.end('failed');
			const path = `${URI.file('/repo').toString()}#file`;
			const rolledBack = f.log.sizeObservations.find(event => event.phase === 'rollback')!;
			f.context.evict('chat');
			assert.deepStrictEqual({
				rollback: { delta: rolledBack.retainedBytesDelta, tracker: rolledBack.trackerEstimatedRetainedBytes },
				fileStatus: f.log.computeObservations.find(event => event.phase === 'file')?.status,
				releases: f.log.sizeObservations.filter(event => event.phase === 'release').map(event => event.hostEstimatedRetainedBytes),
			}, { rollback: { delta: -(256 + 4 + 2 * path.length), tracker: 256 }, fileStatus: 'failed', releases: [0] });
		});

		test('disabled experiment emits no compute or size events and does no extra work', async () => {
			process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG = '0';
			const f = fixture();
			f.begin('disabled');
			await timeout(0);
			assert.deepStrictEqual({
				survival: f.log.characterObservations, compute: f.log.computeObservations, sizes: f.log.sizeObservations,
				gitCalls: f.git.computeFileDiffsBetweenRefs.callCount,
			}, { survival: [], compute: [], sizes: [], gitCalls: 0 });
		});

		test('releases retained bytes at the follow-up horizon before admitting the next origin', async () => {
			sinon.stub(requestDiffSurvivalLimits, 'maximumFollowUpCount').value(1);
			const path = `${URI.file('/repo').toString()}#file`;
			sinon.stub(requestDiffSurvivalLimits, 'maximumRetainedDiffBytes').value(256 + 256 + 4 + 2 * path.length + 128 + 2 * (path.length + 2));
			const f = fixture();
			const fileDiffs = f.git.computeFileDiffsBetweenRefs;
			fileDiffs.callsFake(async (_repository: URI, options: { fromRef: string; toRef: string }) =>
				options.fromRef.replace('-start', '') === options.toRef.replace('-end', '') ? [{
					after: { uri: 'file:///repo/file', content: { uri: 'after' } }, diff: { added: 1, removed: 0 },
				}] : []);
			await f.end('first');
			await f.end('second');
			assert.deepStrictEqual(f.log.characterObservations.map(record => ({
				origin: record.originatingRequestId, status: record.status, index: record.observationIndex, final: record.isFinalObservation,
			})), [
				{ origin: 'first', status: 'measured', index: 0, final: false },
				{ origin: 'first', status: 'measured', index: 1, final: true },
				{ origin: 'second', status: 'measured', index: 0, final: false },
			]);
		});
	});
});

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

class ObservationLogService extends NullLogService {
	readonly firstObservation = new DeferredPromise<string>();
	readonly secondObservation = new DeferredPromise<string>();

	override info(message: string): void {
		const prefix = '[RequestCharacterDiffSurvivalObservation] ';
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
	readonly chatId: string;
	readonly complete: boolean;
	readonly originatingRequestId: string;
	readonly originalRequestUsedEditTool: boolean | null;
	readonly observationRequestId: string;
	readonly observationIndex: number;
	readonly maximumObservationCount: number;
	readonly maximumFollowUpCount: number;
	readonly isFinalObservation: boolean;
	readonly baseModel: string | null;
	readonly observationModel: string | null;
	readonly baseStartTimestamp: string;
	readonly baseEndTimestamp: string;
	readonly observationTimestamp: string;
	readonly observationBoundary: string;
	readonly diffs?: { readonly originalRequest: object };
}

interface IRecordedCharacterObservation extends IRecordedObservation {
	readonly unit: string;
	readonly complete: boolean;
	readonly survival: ReturnType<typeof computeRequestCharacterDiffSurvivalMetric>;
	readonly status: 'measured' | 'budgetExceeded' | 'unavailable';
	readonly terminalReason?: string;
	readonly unavailableReason?: string;
	readonly fileInputBudgetExceeded: number;
	readonly observationInputBudgetExceeded: number;
	readonly retainedDiffBudgetExceeded: number;
	readonly budgetDiagnostics?: RequestDiffSurvivalBudgetError['diagnostics'];
	readonly diffs?: {
		readonly originalRequest: IRequestCharacterRepositoryDiff;
		readonly baselineToLatest: IRequestCharacterRepositoryDiff;
		readonly requestResultToLatest: IRequestCharacterRepositoryDiff;
	};
}

interface IRecordedComputeObservation {
	readonly originatingRequestId: string;
	readonly observationRequestId: string;
	readonly observationIndex: number;
	readonly phase: string;
	readonly status: string;
	readonly comparisonKind?: string;
	readonly repositoryIndex?: number;
	readonly fileIndex?: number;
	readonly computationStarted?: boolean;
	readonly startedFileCount: number;
	readonly elapsedMs: number | null;
	readonly cpuMeasurementStatus: string;
	readonly cpuTotalMs: number | null;
}

interface IRecordedSizeObservation extends IRequestDiffSurvivalSizeDetails {
	readonly originatingRequestId: string;
	readonly observationRequestId: string;
	readonly observationIndex: number;
	readonly observationInputBytes: number;
}

class RecordingObservationLogService extends NullLogService {
	readonly characterObservations: IRecordedCharacterObservation[] = [];
	readonly computeObservations: IRecordedComputeObservation[] = [];
	readonly sizeObservations: IRecordedSizeObservation[] = [];
	private readonly _requestEnds = new Map<string, DeferredPromise<void>>();
	private readonly _expiries = new Map<string, DeferredPromise<void>>();

	whenExpires(requestId: string): Promise<void> {
		const expired = new DeferredPromise<void>();
		this._expiries.set(requestId, expired);
		return expired.p;
	}

	whenRequestEnds(requestId: string): Promise<void> {
		const ended = new DeferredPromise<void>();
		this._requestEnds.set(requestId, ended);
		return ended.p;
	}

	override info(message: string): void {
		if (message.startsWith(RequestDiffSurvivalCostObservation.computeLogPrefix)) {
			this.computeObservations.push(JSON.parse(message.slice(RequestDiffSurvivalCostObservation.computeLogPrefix.length)));
			return;
		}
		if (message.startsWith(RequestDiffSurvivalCostObservation.sizeLogPrefix)) {
			this.sizeObservations.push(JSON.parse(message.slice(RequestDiffSurvivalCostObservation.sizeLogPrefix.length)));
			return;
		}
		const prefix = '[RequestCharacterDiffSurvivalObservation] ';
		if (!message.startsWith(prefix)) {
			return;
		}
		const observation: IRecordedCharacterObservation = JSON.parse(message.slice(prefix.length));
		this.characterObservations.push(observation);
		if (observation.observationBoundary === 'expiry') {
			this._expiries.get(observation.originatingRequestId)?.complete();
			this._expiries.delete(observation.originatingRequestId);
		}
		if (observation.observationIndex === 0) {
			this._requestEnds.get(observation.originatingRequestId)?.complete();
			this._requestEnds.delete(observation.originatingRequestId);
		}
	}
}

class TestExpiryScheduler extends RequestDiffSurvivalExpiryScheduler {
	private _elapsed = 0;
	private _deadline: number | undefined;

	override now(): number {
		return this._elapsed;
	}

	override schedule(delay = 0): void {
		this._deadline = this._elapsed + delay;
	}

	override cancel(): void {
		this._deadline = undefined;
	}

	override isScheduled(): boolean {
		return this._deadline !== undefined;
	}

	advance(duration: number): void {
		this._elapsed += duration;
		if (this._deadline !== undefined && this._deadline <= this._elapsed) {
			this.cancel();
			this.doRun();
		}
	}
}

class TestLifetimeContribution extends RequestDiffSurvivalContribution {
	protected override _createExpiryScheduler(runner: () => void): RequestDiffSurvivalExpiryScheduler {
		return new TestExpiryScheduler(runner, 0);
	}

	get clock(): TestExpiryScheduler {
		assert.ok(this._expiryScheduler instanceof TestExpiryScheduler);
		return this._expiryScheduler;
	}
}

type MementoSegment = string | boolean | number;

class TestContributionContext implements IAgentHostChatContributionContext {
	readonly contributionId = RequestDiffSurvivalContribution.id;
	private readonly _values = new Map<string, ISettableObservable<unknown>>();
	private readonly _cleanups = new Map<string, { resource: ProtocolURI; dispose: () => void }>();

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
		this._cleanups.set(identity, { resource, dispose: () => key.dispose?.(value.get()) });
		return value;
	}

	deleteMemento<T, TExtra extends readonly MementoSegment[]>(
		key: IChatMementoKey<T, TExtra> | ISessionMementoKey<T, TExtra>,
		resource: ProtocolURI,
		...extra: TExtra
	): void {
		const identity = JSON.stringify([key.scope, key.debugName, resource, ...extra]);
		const cleanup = this._cleanups.get(identity);
		this._values.delete(identity);
		this._cleanups.delete(identity);
		cleanup?.dispose();
	}

	evict(resource: ProtocolURI): void {
		for (const [identity, cleanup] of this._cleanups) {
			if (cleanup.resource === resource) {
				this._values.delete(identity);
				this._cleanups.delete(identity);
				cleanup.dispose();
			}
		}
	}
}
