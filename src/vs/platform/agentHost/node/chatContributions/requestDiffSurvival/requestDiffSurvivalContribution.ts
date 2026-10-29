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
import { IAgentEditAttributionService, type IEditAttributionSnapshotSource } from '../../../common/fileEditAttribution.js';
import type { ISessionFileDiff, URI as ProtocolURI } from '../../../common/state/sessionState.js';
import { computeRequestDiffFile, computeRequestDiffSurvivalMetric, type IRequestRepositoryDiff } from './requestDiffSurvival.js';
import { computeRequestCharacterDiffFile, computeRequestCharacterDiffSurvivalMetric, type IRequestCharacterRepositoryDiff } from './requestCharacterDiffSurvival.js';

const requestDiffSurvivalState = createChatMementoKey<IRequestDiffSurvivalState>('requestDiffSurvival.state', () => ({
	starts: new Map(),
	trackers: [],
	characterInitial: undefined,
}));

const MAXIMUM_OBSERVATION_COUNT = 20;
const LOG_PREFIX = '[RequestDiffSurvivalObservation] ';
const CHARACTER_LOG_PREFIX = '[RequestCharacterSurvivalSnapshot] ';
const CHARACTER_DIFF_LOG_PREFIX = '[RequestCharacterDiffSurvivalObservation] ';
const ENABLED_ENVIRONMENT_VARIABLE = 'VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG';

interface IRepositoryState {
	readonly repository: URI;
	readonly ref: string;
}

interface IRequestDiffSurvivalRequestStart {
	readonly repositories: readonly IRepositoryState[];
	readonly model: string | null;
	readonly timestamp: string;
}

interface IRequestDiffSurvivalTracker {
	readonly originatingRequestId: string;
	readonly baseline: readonly IRepositoryState[];
	readonly requestResult: readonly IRepositoryState[];
	readonly originalRequest: IRequestSurvivalDiff;
	readonly baseModel: string | null;
	readonly baseStartTimestamp: string;
	readonly baseEndTimestamp: string;
	observationCount: number;
}

interface IRequestSurvivalDiff extends IRequestRepositoryDiff {
	readonly characterDiff: IRequestCharacterRepositoryDiff;
}

interface IRequestDiffSurvivalState {
	readonly starts: Map<string, IRequestDiffSurvivalRequestStart>;
	readonly trackers: IRequestDiffSurvivalTracker[];
	characterInitial: IRequestCharacterSurvivalInitial | undefined;
}

interface IRequestCharacterSurvivalInitial {
	readonly trackingEpoch: number;
	readonly requestId: string;
	readonly requestBoundary: 'requestStart' | 'requestEnd';
	readonly timestamp: string;
}

interface IRequestCharacterSurvivalObservation {
	readonly schemaVersion: 1;
	readonly recordKind: 'requestCharacterSurvivalSnapshot';
	readonly sessionId: ProtocolURI;
	readonly chatId: ProtocolURI;
	readonly trackingEpoch: number;
	readonly initialRequestId: string;
	readonly initialRequestBoundary: 'requestStart' | 'requestEnd';
	readonly initialTimestamp: string;
	readonly observationRequestId: string;
	readonly observationBoundary: 'requestStart' | 'requestEnd';
	readonly observationTimestamp: string;
	readonly sources: readonly IEditAttributionSnapshotSource[];
}

interface IRequestDiffSurvivalObservation {
	readonly schemaVersion: 2;
	readonly recordKind: 'requestDiffSurvivalObservation';
	readonly sessionId: ProtocolURI;
	readonly chatId: ProtocolURI;
	readonly originatingRequestId: string;
	readonly observationRequestId: string;
	readonly baseModel: string | null;
	readonly observationModel: string | null;
	readonly baseStartTimestamp: string;
	readonly baseEndTimestamp: string;
	readonly observationTimestamp: string;
	readonly observationBoundary: 'requestStart' | 'requestEnd';
	readonly observationIndex: number;
	readonly maximumObservationCount: number;
	readonly isFinalObservation: boolean;
	readonly complete: boolean;
	readonly diffs: {
		readonly originalRequest: Pick<IRequestRepositoryDiff, 'files' | 'errors'>;
		readonly baselineToLatest: Pick<IRequestRepositoryDiff, 'files' | 'errors'>;
		readonly requestResultToLatest: Pick<IRequestRepositoryDiff, 'files' | 'errors'>;
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
		@IAgentEditAttributionService private readonly _editAttributionService: IAgentEditAttributionService,
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
		const observationModel = turn.message.model?.id ?? null;
		const observationTimestamp = new Date().toISOString();
		this._schedule(turn.chat, async () => {
			await this._tryEmitCharacterSnapshot(turn.session, turn.chat, turn.turnId, observationTimestamp, 'requestStart');
			const start = await this._checkpointService.getTurnStartCheckpointState(URI.parse(turn.session), URI.parse(turn.chat), turn.turnId);
			if (!start) {
				this._logService.warn(`[RequestDiffSurvival] No Git start checkpoint for ${turn.chat}/${turn.turnId}; skipping request tracking`);
				return;
			}
			const state = this._state(turn.chat);
			const latest = start.map(checkpoint => ({ repository: checkpoint.repository, ref: checkpoint.tree }));
			state.starts.set(turn.turnId, { repositories: latest, model: observationModel, timestamp: observationTimestamp });
			await this._observeExistingTrackers(turn.session, turn.chat, turn.turnId, observationModel, observationTimestamp, 'requestStart', latest, state);
		});
		return undefined;
	}

	onTurnEnd(turn: ITurnEnd): void {
		if (!this._enabled || !turn.turnId || !this._tracksTurnEnd(turn)) {
			return;
		}
		const turnId = turn.turnId;
		const observationTimestamp = new Date().toISOString();
		this._schedule(turn.channel, async () => {
			const state = this._state(turn.channel);
			await this._tryEmitCharacterSnapshot(turn.session, turn.channel, turnId, observationTimestamp, 'requestEnd');
			const start = state.starts.get(turnId);
			if (!start) {
				return;
			}

			const result = await this._getTurnResultState(turn.session, turn.channel, turnId, start.repositories);
			if (!result) {
				this._logService.warn(`[RequestDiffSurvival] No Git end checkpoint for ${turn.channel}/${turnId}; skipping request tracking`);
				state.starts.delete(turnId);
				return;
			}

			await this._observeExistingTrackers(turn.session, turn.channel, turnId, start.model, observationTimestamp, 'requestEnd', result, state);
			const originalRequest = await this._computeDiff(turn.session, `${turnId}:start`, `${turnId}:end`, start.repositories, result);
			const tracker: IRequestDiffSurvivalTracker = {
				originatingRequestId: turnId,
				baseline: start.repositories,
				requestResult: result,
				originalRequest,
				baseModel: start.model,
				baseStartTimestamp: start.timestamp,
				baseEndTimestamp: observationTimestamp,
				observationCount: 0,
			};
			state.trackers.push(tracker);
			await this._emitObservation(turn.session, turn.channel, turnId, start.model, observationTimestamp, 'requestEnd', result, tracker);
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

	private async _tryEmitCharacterSnapshot(
		session: ProtocolURI,
		chat: ProtocolURI,
		requestId: string,
		timestamp: string,
		boundary: 'requestStart' | 'requestEnd',
	): Promise<void> {
		try {
			const snapshot = await this._editAttributionService.snapshot({ sessionUri: session, chatUri: chat });
			const state = this._state(chat);
			if (!state.characterInitial || state.characterInitial.trackingEpoch !== snapshot.trackingEpoch) {
				state.characterInitial = {
					trackingEpoch: snapshot.trackingEpoch,
					requestId,
					requestBoundary: boundary,
					timestamp,
				};
			}
			const initial = state.characterInitial;
			const observation: IRequestCharacterSurvivalObservation = {
				schemaVersion: 1,
				recordKind: 'requestCharacterSurvivalSnapshot',
				sessionId: session,
				chatId: chat,
				trackingEpoch: snapshot.trackingEpoch,
				initialRequestId: initial.requestId,
				initialRequestBoundary: initial.requestBoundary,
				initialTimestamp: initial.timestamp,
				observationRequestId: requestId,
				observationBoundary: boundary,
				observationTimestamp: timestamp,
				sources: snapshot.sources,
			};
			this._logService.info(`${CHARACTER_LOG_PREFIX}${JSON.stringify(observation)}`);
		} catch (error) {
			this._logService.warn(`[RequestDiffSurvival] Character survival snapshot failed for ${chat}/${requestId}/${boundary}: ${error instanceof Error ? error.message : String(error)}`);
		}
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
		observationModel: string | null,
		observationTimestamp: string,
		boundary: 'requestStart' | 'requestEnd',
		latest: readonly IRepositoryState[],
		state: IRequestDiffSurvivalState,
	): Promise<void> {
		for (let index = 0; index < state.trackers.length;) {
			const tracker = state.trackers[index];
			await this._emitObservation(session, chat, observationRequestId, observationModel, observationTimestamp, boundary, latest, tracker);
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
		observationModel: string | null,
		observationTimestamp: string,
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
			schemaVersion: 2,
			recordKind: 'requestDiffSurvivalObservation',
			sessionId: session,
			chatId: chat,
			originatingRequestId: tracker.originatingRequestId,
			observationRequestId,
			baseModel: tracker.baseModel,
			observationModel,
			baseStartTimestamp: tracker.baseStartTimestamp,
			baseEndTimestamp: tracker.baseEndTimestamp,
			observationTimestamp,
			observationBoundary: boundary,
			observationIndex,
			maximumObservationCount: MAXIMUM_OBSERVATION_COUNT,
			isFinalObservation: observationIndex === MAXIMUM_OBSERVATION_COUNT - 1,
			complete: tracker.originalRequest.errors.length === 0 && baselineToLatest.errors.length === 0 && requestResultToLatest.errors.length === 0,
			diffs: {
				originalRequest: toObservationDiff(tracker.originalRequest),
				baselineToLatest: toObservationDiff(baselineToLatest),
				requestResultToLatest: toObservationDiff(requestResultToLatest),
			},
			survival: computeRequestDiffSurvivalMetric(tracker.originalRequest, baselineToLatest, requestResultToLatest),
		};
		tracker.observationCount++;
		this._logService.info(`${LOG_PREFIX}${JSON.stringify(observation)}`);
		const characterDiffs = {
			originalRequest: tracker.originalRequest.characterDiff,
			baselineToLatest: baselineToLatest.characterDiff,
			requestResultToLatest: requestResultToLatest.characterDiff,
		};
		this._logService.info(`${CHARACTER_DIFF_LOG_PREFIX}${JSON.stringify({
			...observation,
			schemaVersion: 1,
			recordKind: 'requestCharacterDiffSurvivalObservation',
			unit: 'utf16CodeUnit',
			complete: Object.values(characterDiffs).every(diff => diff.errors.length === 0),
			diffs: characterDiffs,
			survival: computeRequestCharacterDiffSurvivalMetric(characterDiffs.originalRequest, characterDiffs.baselineToLatest, characterDiffs.requestResultToLatest),
		})}`);
	}

	private async _computeDiff(
		session: ProtocolURI,
		from: string,
		to: string,
		before: readonly IRepositoryState[],
		after: readonly IRepositoryState[],
	): Promise<IRequestSurvivalDiff> {
		const afterByRepository = new Map(after.map(state => [state.repository.toString(), state.ref]));
		const files = [];
		const errors: string[] = [];
		const characterFiles = [];
		const characterErrors: string[] = [];
		for (const beforeRepository of before) {
			const afterRef = afterByRepository.get(beforeRepository.repository.toString());
			if (!afterRef) {
				errors.push(`Missing latest state for repository ${beforeRepository.repository.toString()}`);
				characterErrors.push(errors[errors.length - 1]);
				continue;
			}
			const diffs = await this._gitService.computeFileDiffsBetweenRefs(beforeRepository.repository, {
				sessionUri: session,
				fromRef: beforeRepository.ref,
				toRef: afterRef,
			});
			if (!diffs) {
				errors.push(`Failed to compute diff for repository ${beforeRepository.repository.toString()}`);
				characterErrors.push(errors[errors.length - 1]);
				continue;
			}
			for (const diff of diffs) {
				try {
					const materialized = await this._materializeFileDiff(beforeRepository.repository, beforeRepository.ref, afterRef, diff);
					files.push(materialized.line);
					characterFiles.push(...materialized.character.files);
					characterErrors.push(...materialized.character.errors);
				} catch (error) {
					errors.push(`Failed to materialize ${diff.after?.uri ?? diff.before?.uri ?? 'unknown file'}: ${error instanceof Error ? error.message : String(error)}`);
					characterErrors.push(errors[errors.length - 1]);
				}
			}
		}
		return { from, to, files, errors, characterDiff: { files: characterFiles, errors: characterErrors } };
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
		const originalPath = beforePath ? `${repository.toString()}#${beforePath}` : undefined;
		const modifiedPath = afterPath ? `${repository.toString()}#${afterPath}` : undefined;
		const originalText = before?.toString() ?? '';
		const modifiedText = after?.toString() ?? '';
		const line = computeRequestDiffFile(originalPath, modifiedPath, originalText, modifiedText);
		let character: IRequestCharacterRepositoryDiff;
		try {
			character = { files: [computeRequestCharacterDiffFile(originalPath, modifiedPath, originalText, modifiedText)], errors: [] };
		} catch (error) {
			character = { files: [], errors: [`Failed to compute character diff for ${originalPath ?? modifiedPath}: ${error instanceof Error ? error.message : String(error)}`] };
		}
		return { line, character };
	}
}

function emptyRepositoryDiff(from: string, to: string): IRequestSurvivalDiff {
	return { from, to, files: [], errors: [], characterDiff: { files: [], errors: [] } };
}

function toObservationDiff(diff: IRequestRepositoryDiff): Pick<IRequestRepositoryDiff, 'files' | 'errors'> {
	return { files: diff.files, errors: diff.errors };
}
