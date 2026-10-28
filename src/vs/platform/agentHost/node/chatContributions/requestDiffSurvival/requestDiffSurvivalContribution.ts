/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SequencerByKey } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILogService } from '../../../../log/common/log.js';
import { IAgentHostCheckpointService } from '../../../common/agentHostCheckpointService.js';
import { createChatMementoKey, type IAgentHostChatContribution, type IAgentHostChatContributionContext, type IOutgoingTurn, type ITurnEnd } from '../../../common/agentHostChatContributionsService.js';
import { IAgentHostGitService } from '../../../common/agentHostGitService.js';
import type { ISessionFileDiff, URI as ProtocolURI } from '../../../common/state/sessionState.js';
import { computeRequestDiffFile, computeRequestDiffSurvivalMetric, type IRequestRepositoryDiff } from './requestDiffSurvival.js';

const requestDiffSurvivalState = createChatMementoKey<IRequestDiffSurvivalState>('requestDiffSurvival.state', () => ({
	starts: new Map(),
	trackers: [],
}));

const MAXIMUM_OBSERVATION_COUNT = 10;
const LOG_PREFIX = '[RequestDiffSurvivalObservation] ';
const ENABLED_ENVIRONMENT_VARIABLE = 'VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG';

interface IRepositoryState {
	readonly repository: URI;
	readonly ref: string;
}

interface IRequestDiffSurvivalTracker {
	readonly originatingRequestId: string;
	readonly baseline: readonly IRepositoryState[];
	readonly requestResult: readonly IRepositoryState[];
	readonly originalRequest: IRequestRepositoryDiff;
	observationCount: number;
}

interface IRequestDiffSurvivalState {
	readonly starts: Map<string, readonly IRepositoryState[]>;
	readonly trackers: IRequestDiffSurvivalTracker[];
}

interface IRequestDiffSurvivalObservation {
	readonly schemaVersion: 1;
	readonly recordKind: 'requestDiffSurvivalObservation';
	readonly sessionId: ProtocolURI;
	readonly chatId: ProtocolURI;
	readonly originatingRequestId: string;
	readonly observationRequestId: string;
	readonly observationBoundary: 'requestStart' | 'requestEnd';
	readonly observationIndex: number;
	readonly maximumObservationCount: number;
	readonly isFinalObservation: boolean;
	readonly complete: boolean;
	readonly states: {
		readonly baseline: string;
		readonly requestResult: string;
		readonly latestAvailable: string;
	};
	readonly diffs: {
		readonly originalRequest: IRequestRepositoryDiff;
		readonly baselineToLatest: IRequestRepositoryDiff;
		readonly requestResultToLatest: IRequestRepositoryDiff;
	};
	readonly survival: ReturnType<typeof computeRequestDiffSurvivalMetric>;
}

/** Logs bounded triple-diff survival observations for completed Git-backed requests. */
export class RequestDiffSurvivalContribution extends Disposable implements IAgentHostChatContribution {

	static readonly id = 'requestDiffSurvival';
	readonly order = 150;

	private readonly _enabled = process.env[ENABLED_ENVIRONMENT_VARIABLE] === '1';
	private readonly _observations = new SequencerByKey<ProtocolURI>();

	constructor(
		protected readonly _context: IAgentHostChatContributionContext,
		@ILogService private readonly _logService: ILogService,
		@IAgentHostCheckpointService private readonly _checkpointService: IAgentHostCheckpointService,
		@IAgentHostGitService private readonly _gitService: IAgentHostGitService,
	) {
		super();
		if (this._enabled) {
			this._logService.info('[RequestDiffSurvival] Enabled for Agent Host chats');
		}
	}

	onOutgoingTurn(turn: IOutgoingTurn): undefined {
		if (!this._enabled) {
			return undefined;
		}
		this._schedule(turn.chat, async () => {
			const start = await this._checkpointService.getTurnStartCheckpointState(URI.parse(turn.session), URI.parse(turn.chat), turn.turnId);
			if (!start) {
				this._logService.warn(`[RequestDiffSurvival] No Git start checkpoint for ${turn.chat}/${turn.turnId}; skipping request tracking`);
				return;
			}
			const state = this._state(turn.chat);
			const latest = start.map(checkpoint => ({ repository: checkpoint.repository, ref: checkpoint.tree }));
			state.starts.set(turn.turnId, latest);
			await this._observeExistingTrackers(turn.session, turn.chat, turn.turnId, 'requestStart', latest, state);
		});
		return undefined;
	}

	onTurnEnd(turn: ITurnEnd): void {
		if (!this._enabled || !turn.turnId || !this._tracksTurnEnd(turn)) {
			return;
		}
		const turnId = turn.turnId;
		this._schedule(turn.channel, async () => {
			const state = this._state(turn.channel);
			const start = state.starts.get(turnId);
			if (!start) {
				return;
			}

			const result = await this._getTurnResultState(turn.session, turn.channel, turnId, start);
			if (!result) {
				this._logService.warn(`[RequestDiffSurvival] No Git end checkpoint for ${turn.channel}/${turnId}; skipping request tracking`);
				state.starts.delete(turnId);
				return;
			}

			await this._observeExistingTrackers(turn.session, turn.channel, turnId, 'requestEnd', result, state);
			const originalRequest = await this._computeDiff(turn.session, `${turnId}:start`, `${turnId}:end`, start, result);
			const tracker: IRequestDiffSurvivalTracker = {
				originatingRequestId: turnId,
				baseline: start,
				requestResult: result,
				originalRequest,
				observationCount: 0,
			};
			state.trackers.push(tracker);
			await this._emitObservation(turn.session, turn.channel, turnId, 'requestEnd', result, tracker);
			state.starts.delete(turnId);
		});
	}

	private _tracksTurnEnd(turn: ITurnEnd): boolean {
		return turn.reason.kind === 'success'
			|| turn.reason.kind === 'cancelled'
			|| (turn.reason.kind === 'error' && !turn.reason.resumable);
	}

	private _schedule(chat: ProtocolURI, task: () => Promise<void>): void {
		void this._observations.queue(chat, task).catch(error => {
			this._logService.warn(`[RequestDiffSurvival] Observation failed for ${chat}: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	private _state(chat: ProtocolURI): IRequestDiffSurvivalState {
		return this._context.memento(requestDiffSurvivalState, chat).get();
	}

	private async _getTurnResultState(
		session: ProtocolURI,
		chat: ProtocolURI,
		turnId: string,
		start: readonly IRepositoryState[],
	): Promise<readonly IRepositoryState[] | undefined> {
		const result: IRepositoryState[] = [];
		for (const { repository } of start) {
			const pair = await this._checkpointService.waitForTurnCheckpointPair(URI.parse(session), URI.parse(chat), turnId, repository);
			if (!pair) {
				return undefined;
			}
			result.push({ repository, ref: pair.current });
		}
		return result;
	}

	private async _observeExistingTrackers(
		session: ProtocolURI,
		chat: ProtocolURI,
		observationRequestId: string,
		boundary: 'requestStart' | 'requestEnd',
		latest: readonly IRepositoryState[],
		state: IRequestDiffSurvivalState,
	): Promise<void> {
		for (let index = 0; index < state.trackers.length;) {
			const tracker = state.trackers[index];
			await this._emitObservation(session, chat, observationRequestId, boundary, latest, tracker);
			if (tracker.observationCount >= MAXIMUM_OBSERVATION_COUNT) {
				state.trackers.splice(index, 1);
			} else {
				index++;
			}
		}
	}

	private async _emitObservation(
		session: ProtocolURI,
		chat: ProtocolURI,
		observationRequestId: string,
		boundary: 'requestStart' | 'requestEnd',
		latest: readonly IRepositoryState[],
		tracker: IRequestDiffSurvivalTracker,
	): Promise<void> {
		const observationIndex = tracker.observationCount;
		const latestState = `${observationRequestId}:${boundary === 'requestStart' ? 'start' : 'end'}`;
		const baselineToLatest = observationIndex === 0
			? tracker.originalRequest
			: await this._computeDiff(session, `${tracker.originatingRequestId}:start`, latestState, tracker.baseline, latest);
		const requestResultToLatest = observationIndex === 0
			? emptyRepositoryDiff(`${tracker.originatingRequestId}:end`, latestState)
			: await this._computeDiff(session, `${tracker.originatingRequestId}:end`, latestState, tracker.requestResult, latest);
		const observation: IRequestDiffSurvivalObservation = {
			schemaVersion: 1,
			recordKind: 'requestDiffSurvivalObservation',
			sessionId: session,
			chatId: chat,
			originatingRequestId: tracker.originatingRequestId,
			observationRequestId,
			observationBoundary: boundary,
			observationIndex,
			maximumObservationCount: MAXIMUM_OBSERVATION_COUNT,
			isFinalObservation: observationIndex === MAXIMUM_OBSERVATION_COUNT - 1,
			complete: tracker.originalRequest.errors.length === 0 && baselineToLatest.errors.length === 0 && requestResultToLatest.errors.length === 0,
			states: {
				baseline: `${tracker.originatingRequestId}:start`,
				requestResult: `${tracker.originatingRequestId}:end`,
				latestAvailable: latestState,
			},
			diffs: {
				originalRequest: tracker.originalRequest,
				baselineToLatest,
				requestResultToLatest,
			},
			survival: computeRequestDiffSurvivalMetric(tracker.originalRequest, baselineToLatest, requestResultToLatest),
		};
		tracker.observationCount++;
		this._logService.info(`${LOG_PREFIX}${JSON.stringify(observation)}`);
	}

	private async _computeDiff(
		session: ProtocolURI,
		from: string,
		to: string,
		before: readonly IRepositoryState[],
		after: readonly IRepositoryState[],
	): Promise<IRequestRepositoryDiff> {
		const afterByRepository = new Map(after.map(state => [state.repository.toString(), state.ref]));
		const files = [];
		const errors: string[] = [];
		for (const beforeRepository of before) {
			const afterRef = afterByRepository.get(beforeRepository.repository.toString());
			if (!afterRef) {
				errors.push(`Missing latest state for repository ${beforeRepository.repository.toString()}`);
				continue;
			}
			const diffs = await this._gitService.computeFileDiffsBetweenRefs(beforeRepository.repository, {
				sessionUri: session,
				fromRef: beforeRepository.ref,
				toRef: afterRef,
			});
			if (!diffs) {
				errors.push(`Failed to compute diff for repository ${beforeRepository.repository.toString()}`);
				continue;
			}
			for (const diff of diffs) {
				try {
					files.push(await this._materializeFileDiff(beforeRepository.repository, beforeRepository.ref, afterRef, diff));
				} catch (error) {
					errors.push(`Failed to materialize ${diff.after?.uri ?? diff.before?.uri ?? 'unknown file'}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
		return { from, to, files, errors };
	}

	private async _materializeFileDiff(repository: URI, beforeRef: string, afterRef: string, diff: ISessionFileDiff) {
		const beforePath = diff.before ? relativePath(repository, URI.parse(diff.before.uri)) : undefined;
		const afterPath = diff.after ? relativePath(repository, URI.parse(diff.after.uri)) : undefined;
		const [before, after] = await Promise.all([
			beforePath ? this._gitService.showBlob(repository, beforeRef, beforePath) : undefined,
			afterPath ? this._gitService.showBlob(repository, afterRef, afterPath) : undefined,
		]);
		if (beforePath && !before) {
			throw new Error(`Missing before blob ${beforeRef}:${beforePath}`);
		}
		if (afterPath && !after) {
			throw new Error(`Missing after blob ${afterRef}:${afterPath}`);
		}
		return computeRequestDiffFile(
			beforePath ? `${repository.toString()}#${beforePath}` : undefined,
			afterPath ? `${repository.toString()}#${afterPath}` : undefined,
			before?.toString() ?? '',
			after?.toString() ?? '',
		);
	}
}

function emptyRepositoryDiff(from: string, to: string): IRequestRepositoryDiff {
	return { from, to, files: [], errors: [] };
}
