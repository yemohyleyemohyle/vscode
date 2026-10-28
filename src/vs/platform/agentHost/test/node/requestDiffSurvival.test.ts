/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { observableValue, type ISettableObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IAgentHostCheckpointService, NULL_CHECKPOINT_SERVICE } from '../../common/agentHostCheckpointService.js';
import type { IAgentHostChatContributionContext, IChatMementoKey, ISessionMementoKey } from '../../common/agentHostChatContributionsService.js';
import { IAgentHostGitService } from '../../common/agentHostGitService.js';
import { NullAgentEditAttributionService } from '../../common/fileEditAttribution.js';
import { MessageKind, type URI as ProtocolURI } from '../../common/state/sessionState.js';
import { RequestDiffSurvivalContribution } from '../../node/chatContributions/requestDiffSurvival/requestDiffSurvivalContribution.js';
import { computeRequestDiffFile, computeRequestDiffSurvivalMetric, type IRequestRepositoryDiff } from '../../node/chatContributions/requestDiffSurvival/requestDiffSurvival.js';
import { createNoopGitService } from '../common/sessionTestHelpers.js';

suite('Agent Host Request Diff Survival', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

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
				new NullAgentEditAttributionService(),
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
				base: observationShape(baseObservation),
				later: observationShape(laterObservation),
				baseTimestampsMatchAcrossObservations:
					baseObservation.baseStartTimestamp === laterObservation.baseStartTimestamp
					&& baseObservation.baseEndTimestamp === laterObservation.baseEndTimestamp,
			}, {
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
