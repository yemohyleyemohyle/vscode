/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SequencerByKey } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { CancellationError, isCancellationError } from '../../../../../base/common/errors.js';
import { relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILogService } from '../../../../log/common/log.js';
import { IAgentHostCheckpointService } from '../../../common/agentHostCheckpointService.js';
import { createChatMementoKey, type IAgentHostChatContribution, type IAgentHostChatContributionContext, type IDispatchedAction, type IOutgoingTurn, type ITurnEnd } from '../../../common/agentHostChatContributionsService.js';
import { IAgentHostGitService } from '../../../common/agentHostGitService.js';
import { CLAUDE_AGENT_PROVIDER_ID, COPILOT_CLI_AGENT_PROVIDER_ID } from '../../../common/agent.js';
import { readToolCallMeta } from '../../../common/meta/agentToolCallMeta.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import type { ISessionFileDiff, URI as ProtocolURI } from '../../../common/state/sessionState.js';
import { AgentHostStateManager, IAgentHostStateManager } from '../../agentHostStateManager.js';
import { computeRequestCharacterDiffFile, computeRequestCharacterDiffSurvivalMetric, type IRequestCharacterRepositoryDiff } from './requestCharacterDiffSurvival.js';
import { RequestDiffSurvivalBudgetError, RequestDiffSurvivalInputBudget, requestDiffSurvivalLimits } from './requestDiffSurvivalLimits.js';
import { getRequestDiffSurvivalCostOutcome, RequestDiffSurvivalCostObservation, type IRequestDiffSurvivalFileCost, type IRequestDiffSurvivalSizeDetails, type RequestDiffSurvivalComparison, type RequestDiffSurvivalCostOutcome } from './requestDiffSurvivalCost.js';

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
	originalRequest: IRequestCharacterRepositoryDiff | undefined;
	retainedBytes: number;
	readonly baseModel: string | null;
	readonly baseStartTimestamp: string;
	readonly baseEndTimestamp: string;
	readonly originalRequestUsedEditTool: boolean | null;
	observationCount: number;
	cost: RequestDiffSurvivalCostObservation;
}

interface IRequestDiffSurvivalState {
	readonly starts: Map<string, IRequestDiffSurvivalRequestStart>;
	readonly requestEvidence: Map<string, IRequestEditToolEvidence>;
	readonly toolRequests: Map<string, { readonly chat: ProtocolURI; readonly turnId: string }>;
	readonly trackers: IRequestDiffSurvivalTracker[];
	isDisposed: boolean;
}

interface IRequestEditToolEvidence {
	readonly supported: boolean;
	readonly tools: Map<ProtocolURI, Map<string, boolean | undefined>>;
}

interface IRequestCharacterDiffSurvivalObservation {
	readonly schemaVersion: 3;
	readonly recordKind: 'requestCharacterDiffSurvivalObservation';
	readonly unit: 'utf16CodeUnit';
	readonly sessionId: ProtocolURI;
	readonly chatId: ProtocolURI;
	readonly originatingRequestId: string;
	readonly originalRequestUsedEditTool: boolean | null;
	readonly observationRequestId: string;
	readonly baseModel: string | null;
	readonly observationModel: string | null;
	readonly baseStartTimestamp: string;
	readonly baseEndTimestamp: string;
	readonly observationTimestamp: string;
	readonly observationBoundary: 'requestEnd';
	readonly observationIndex: number;
	readonly maximumObservationCount: number;
	readonly maximumFollowUpCount: number;
	readonly isFinalObservation: boolean;
	readonly complete: boolean;
	readonly status: 'measured' | 'budgetExceeded';
	readonly fileInputBudgetExceeded: 0 | 1;
	readonly observationInputBudgetExceeded: 0 | 1;
	readonly retainedDiffBudgetExceeded: 0 | 1;
	readonly limits: typeof requestDiffSurvivalLimits;
	readonly budgetDiagnostics?: RequestDiffSurvivalBudgetError['diagnostics'];
	readonly diffs?: {
		readonly originalRequest: IRequestCharacterRepositoryDiff;
		readonly baselineToLatest: IRequestCharacterRepositoryDiff;
		readonly requestResultToLatest: IRequestCharacterRepositoryDiff;
	};
	readonly survival: ReturnType<typeof computeRequestCharacterDiffSurvivalMetric>;
}

/** Logs bounded triple-diff survival observations for completed Git-backed requests. */
export class RequestDiffSurvivalContribution extends Disposable implements IAgentHostChatContribution {

	static readonly id = 'requestDiffSurvival';
	readonly order = 150;

	private readonly _enabled = process.env[ENABLED_ENVIRONMENT_VARIABLE] === '1';
	private readonly _observations = new SequencerByKey<ProtocolURI>();
	private _retainedBytes = 0;
	private readonly _stateKey = createChatMementoKey<IRequestDiffSurvivalState>('requestDiffSurvival.state', () => ({
		starts: new Map(), requestEvidence: new Map(), toolRequests: new Map(), trackers: [], isDisposed: false,
	}), state => {
		state.isDisposed = true;
		for (const tracker of [...state.trackers]) {
			this._retireTracker(state, tracker, 'stateDisposed');
		}
		state.starts.clear();
		state.requestEvidence.clear();
		state.toolRequests.clear();
	});

	constructor(
		protected readonly _context: IAgentHostChatContributionContext,
		@ILogService private readonly _logService: ILogService,
		@IAgentHostCheckpointService private readonly _checkpointService: IAgentHostCheckpointService,
		@IAgentHostGitService private readonly _gitService: IAgentHostGitService,
		@IAgentHostStateManager private readonly _stateManager: AgentHostStateManager,
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
		const state = this._state(turn.chat);
		if (!state.requestEvidence.has(turn.turnId)) {
			const provider = this._stateManager.getSessionState(turn.session)?.provider;
			state.requestEvidence.set(turn.turnId, {
				supported: provider === COPILOT_CLI_AGENT_PROVIDER_ID || provider === CLAUDE_AGENT_PROVIDER_ID,
				tools: new Map(),
			});
		}
		const observationModel = turn.message.model?.id ?? turn.effectiveModel?.id ?? null;
		const observationTimestamp = new Date().toISOString();
		this._schedule(turn.chat, state, async () => {
			const start = await this._checkpointService.getTurnStartCheckpointState(URI.parse(turn.session), URI.parse(turn.chat), turn.turnId);
			this._assertActive(state);
			if (!start) {
				this._logService.warn(`[RequestDiffSurvival] No Git start checkpoint for ${turn.chat}/${turn.turnId}; skipping request tracking`);
				return;
			}
			const latest = start.map(checkpoint => ({ repository: checkpoint.repository, ref: checkpoint.tree }));
			state.starts.set(turn.turnId, { repositories: latest, model: observationModel, timestamp: observationTimestamp });
		});
		return undefined;
	}

	onDidDispatchAction(dispatched: IDispatchedAction): void {
		if (!this._enabled || dispatched.rejectionReason) {
			return;
		}
		const { action } = dispatched;
		if (action.type !== ActionType.ChatToolCallStart
			&& action.type !== ActionType.ChatToolCallReady
			&& action.type !== ActionType.ChatToolCallComplete
			&& action.type !== ActionType.ChatToolCallConfirmed) {
			return;
		}
		const state = this._state(dispatched.channel);
		const meta = dispatched.origin ? {} : readToolCallMeta(action);
		const request = state.toolRequests.get(action.toolCallId) ?? meta['vscode.toolRequest']
			?? { chat: dispatched.channel, turnId: action.turnId };
		const evidence = this._state(request.chat).requestEvidence.get(request.turnId);
		if (!evidence) {
			return;
		}
		state.toolRequests.set(action.toolCallId, request);
		let tools = evidence.tools.get(dispatched.channel);
		if (!tools) {
			tools = new Map();
			evidence.tools.set(dispatched.channel, tools);
		}
		if (!tools.has(action.toolCallId)) {
			tools.set(action.toolCallId, undefined);
		}
		if (tools.get(action.toolCallId) !== true) {
			if (action.type === ActionType.ChatToolCallComplete) {
				const executed = meta['vscode.editToolExecution'];
				if (executed !== undefined || tools.get(action.toolCallId) !== false) {
					tools.set(action.toolCallId, executed);
				}
			} else if (action.type === ActionType.ChatToolCallConfirmed && !action.approved) {
				tools.set(action.toolCallId, false);
			}
		}
	}

	onTurnEnd(turn: ITurnEnd): void {
		if (!this._enabled || !turn.turnId || !this._tracksTurnEnd(turn)) {
			return;
		}
		const turnId = turn.turnId;
		const originalRequestUsedEditTool = this._finishEvidence(turn.channel, turnId);
		const observationTimestamp = new Date().toISOString();
		const state = this._state(turn.channel);
		this._schedule(turn.channel, state, async () => {
			const start = state.starts.get(turnId);
			if (!start) {
				return;
			}

			const result = await this._getTurnResultState(turn.session, turn.channel, turnId, start.repositories);
			this._assertActive(state);
			if (!result) {
				this._logService.warn(`[RequestDiffSurvival] No Git end checkpoint for ${turn.channel}/${turnId}; skipping request tracking`);
				state.starts.delete(turnId);
				return;
			}

			await this._observeExistingTrackers(turn.session, turn.channel, turnId, start.model, observationTimestamp, result, state);
			this._assertActive(state);
			const tracker: IRequestDiffSurvivalTracker = {
				originatingRequestId: turnId,
				baseline: start.repositories,
				requestResult: result,
				originalRequest: undefined,
				retainedBytes: 0,
				baseModel: start.model,
				baseStartTimestamp: start.timestamp,
				baseEndTimestamp: observationTimestamp,
				originalRequestUsedEditTool,
				observationCount: 0,
				cost: new RequestDiffSurvivalCostObservation(this._logService, {
					sessionId: turn.session, chatId: turn.channel, originatingRequestId: turnId,
					observationRequestId: turnId, observationIndex: 0,
				}),
			};
			state.trackers.push(tracker);
			await this._emitObservation(turn.session, turn.channel, turnId, start.model, observationTimestamp, result, tracker, state);
			state.starts.delete(turnId);
		});
	}

	private _finishEvidence(chat: ProtocolURI, turnId: string): boolean | null {
		const state = this._state(chat);
		const evidence = state.requestEvidence.get(turnId);
		state.requestEvidence.delete(turnId);
		if (!evidence) {
			return null;
		}
		let result: boolean | null = evidence.supported ? false : null;
		for (const [toolChat, tools] of evidence.tools) {
			const toolState = this._state(toolChat);
			for (const [toolCallId, executed] of tools) {
				toolState.toolRequests.delete(toolCallId);
				if (executed === true) {
					result = true;
				} else if (executed === undefined && result !== true) {
					result = null;
				}
			}
		}
		return result;
	}

	private _tracksTurnEnd(turn: ITurnEnd): boolean {
		return turn.reason.kind === 'success'
			|| turn.reason.kind === 'cancelled'
			|| (turn.reason.kind === 'error' && !turn.reason.resumable);
	}

	private _schedule(chat: ProtocolURI, state: IRequestDiffSurvivalState, task: () => Promise<void>): void {
		void this._observations.queue(chat, async () => {
			this._assertActive(state);
			await task();
		}).catch(error => {
			if (isCancellationError(error)) {
				return;
			}
			this._logService.warn(`[RequestDiffSurvival] Observation failed for ${chat}: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	private _state(chat: ProtocolURI): IRequestDiffSurvivalState {
		return this._context.memento(this._stateKey, chat).get();
	}

	private _assertActive(state: IRequestDiffSurvivalState): void {
		if (state.isDisposed || this._store.isDisposed) {
			throw new CancellationError();
		}
	}

	private _reserveRetained(
		state: IRequestDiffSurvivalState, tracker: IRequestDiffSurvivalTracker, bytes: number,
		file?: IRequestDiffSurvivalFileCost,
	): void {
		this._assertActive(state);
		const proposedRetainedDiffBytes = this._retainedBytes + bytes;
		if (proposedRetainedDiffBytes > requestDiffSurvivalLimits.maximumRetainedDiffBytes) {
			this._sizeEvent(tracker, {
				phase: 'budgetRejection', status: 'budgetRejected', ...this._fileSizeDetails(file),
				proposedHostEstimatedRetainedBytes: proposedRetainedDiffBytes,
			});
			this._retireTracker(state, tracker, 'budgetRejected');
			throw new RequestDiffSurvivalBudgetError(false, false, true, { proposedRetainedDiffBytes });
		}
		this._retainedBytes = proposedRetainedDiffBytes;
		tracker.retainedBytes += bytes;
	}

	private _retireTracker(
		state: IRequestDiffSurvivalState, tracker: IRequestDiffSurvivalTracker,
		reason: NonNullable<IRequestDiffSurvivalSizeDetails['reason']>,
	): void {
		const index = state.trackers.indexOf(tracker);
		const retainedBytes = tracker.retainedBytes;
		const wasTracked = index >= 0 || retainedBytes > 0;
		if (index >= 0) {
			state.trackers.splice(index, 1);
		}
		this._retainedBytes -= tracker.retainedBytes;
		tracker.retainedBytes = 0;
		tracker.originalRequest = undefined;
		if (wasTracked) {
			this._sizeEvent(tracker, { phase: 'release', status: 'completed', reason, retainedBytesDelta: -retainedBytes });
		}
	}

	private _sizeEvent(
		tracker: IRequestDiffSurvivalTracker,
		details: Omit<IRequestDiffSurvivalSizeDetails, 'trackerEstimatedRetainedBytes' | 'hostEstimatedRetainedBytes'>,
	): void {
		tracker.cost.size({
			...details, trackerEstimatedRetainedBytes: tracker.retainedBytes, hostEstimatedRetainedBytes: this._retainedBytes,
		});
	}

	private _fileSizeDetails(file?: IRequestDiffSurvivalFileCost) {
		return file ? {
			comparisonKind: file.comparisonKind, repositoryIndex: file.repositoryIndex,
			fileIndex: file.fileIndex, fileInputBytes: file.fileInputBytes,
		} : {};
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
		latest: readonly IRepositoryState[],
		state: IRequestDiffSurvivalState,
	): Promise<void> {
		for (const tracker of [...state.trackers]) {
			this._assertActive(state);
			await this._emitObservation(session, chat, observationRequestId, observationModel, observationTimestamp, latest, tracker, state);
		}
	}

	private async _emitObservation(
		session: ProtocolURI,
		chat: ProtocolURI,
		observationRequestId: string,
		observationModel: string | null,
		observationTimestamp: string,
		latest: readonly IRepositoryState[],
		tracker: IRequestDiffSurvivalTracker,
		state: IRequestDiffSurvivalState,
	): Promise<void> {
		const cost = tracker.observationCount === 0 ? tracker.cost : tracker.cost = new RequestDiffSurvivalCostObservation(this._logService, {
			sessionId: session, chatId: chat, originatingRequestId: tracker.originatingRequestId,
			observationRequestId, observationIndex: tracker.observationCount,
		});
		let outcome: RequestDiffSurvivalCostOutcome = 'failed';
		try {
			const budget = cost.inputBudget;
			if (!tracker.originalRequest) {
				this._reserveRetained(state, tracker, 256);
				this._sizeEvent(tracker, { phase: 'admission', status: 'started', retainedBytesDelta: 256 });
				const original = await this._computeDiff(session, tracker.baseline, latest, budget, state, tracker, 'originalRequest', true);
				this._assertActive(state);
				tracker.originalRequest = original;
				this._sizeEvent(tracker, { phase: 'admission', status: 'completed' });
			} else {
				cost.finishComparison('originalRequest', 'reused');
			}
			const originalRequest = tracker.originalRequest;
			const baselineToLatest = tracker.observationCount === 0
				? originalRequest
				: await this._computeDiff(session, tracker.baseline, latest, budget, state, tracker, 'baselineToLatest', false);
			const requestResultToLatest = tracker.observationCount === 0
				? { files: [], errors: [] }
				: await this._computeDiff(session, tracker.requestResult, latest, budget, state, tracker, 'requestResultToLatest', false);
			if (tracker.observationCount === 0) {
				cost.finishComparison('baselineToLatest', 'reused');
				cost.finishComparison('requestResultToLatest', 'empty');
			}
			this._assertActive(state);
			outcome = [originalRequest, baselineToLatest, requestResultToLatest].some(diff => diff.errors.length > 0) ? 'failed' : 'completed';
			this._writeObservation(session, chat, observationRequestId, observationModel, observationTimestamp, tracker, {
				originalRequest, baselineToLatest, requestResultToLatest,
			});
			tracker.observationCount++;
			if (tracker.observationCount > requestDiffSurvivalLimits.maximumFollowUpCount) {
				this._retireTracker(state, tracker, 'horizon');
			}
		} catch (error) {
			outcome = getRequestDiffSurvivalCostOutcome(error);
			if (error instanceof RequestDiffSurvivalBudgetError) {
				this._assertActive(state);
				this._writeObservation(session, chat, observationRequestId, observationModel, observationTimestamp, tracker, undefined, error);
				this._retireTracker(state, tracker, 'budgetRejected');
			} else {
				this._retireTracker(state, tracker, isCancellationError(error) ? 'cancelled' : 'failed');
				throw error;
			}
		} finally {
			cost.finishObservation(outcome);
			this._sizeEvent(tracker, { phase: 'observation', status: outcome });
		}
	}

	private _writeObservation(
		session: ProtocolURI,
		chat: ProtocolURI,
		observationRequestId: string,
		observationModel: string | null,
		observationTimestamp: string,
		tracker: IRequestDiffSurvivalTracker,
		diffs: IRequestCharacterDiffSurvivalObservation['diffs'],
		error?: RequestDiffSurvivalBudgetError,
	): void {
		const observation: IRequestCharacterDiffSurvivalObservation = {
			schemaVersion: 3,
			recordKind: 'requestCharacterDiffSurvivalObservation',
			unit: 'utf16CodeUnit',
			sessionId: session,
			chatId: chat,
			originatingRequestId: tracker.originatingRequestId,
			originalRequestUsedEditTool: tracker.originalRequestUsedEditTool,
			observationRequestId,
			baseModel: tracker.baseModel,
			observationModel,
			baseStartTimestamp: tracker.baseStartTimestamp,
			baseEndTimestamp: tracker.baseEndTimestamp,
			observationTimestamp,
			observationBoundary: 'requestEnd',
			observationIndex: tracker.observationCount,
			maximumObservationCount: requestDiffSurvivalLimits.maximumFollowUpCount + 1,
			maximumFollowUpCount: requestDiffSurvivalLimits.maximumFollowUpCount,
			isFinalObservation: !!error || tracker.observationCount === requestDiffSurvivalLimits.maximumFollowUpCount,
			complete: !!diffs && Object.values(diffs).every(diff => diff.errors.length === 0),
			status: error ? 'budgetExceeded' : 'measured',
			fileInputBudgetExceeded: error?.fileInputBudgetExceeded ? 1 : 0,
			observationInputBudgetExceeded: error?.observationInputBudgetExceeded ? 1 : 0,
			retainedDiffBudgetExceeded: error?.retainedDiffBudgetExceeded ? 1 : 0,
			limits: requestDiffSurvivalLimits,
			budgetDiagnostics: error?.diagnostics,
			diffs,
			survival: diffs ? computeRequestCharacterDiffSurvivalMetric(diffs.originalRequest, diffs.baselineToLatest, diffs.requestResultToLatest) : {
				survivingAdditions: -1, survivingDeletions: -1, totalAdditions: -1, totalDeletions: -1, totalSurviving: -1, totalEdits: -1, ratio: -1,
			},
		};
		this._logService.info(`${CHARACTER_DIFF_LOG_PREFIX}${JSON.stringify(observation)}`);
	}

	private async _computeDiff(
		session: ProtocolURI,
		before: readonly IRepositoryState[],
		after: readonly IRepositoryState[],
		budget: RequestDiffSurvivalInputBudget,
		state: IRequestDiffSurvivalState,
		tracker: IRequestDiffSurvivalTracker,
		comparison: RequestDiffSurvivalComparison,
		retain: boolean,
	): Promise<IRequestCharacterRepositoryDiff> {
		const cost = tracker.cost;
		cost.beginComparison(comparison);
		let outcome: RequestDiffSurvivalCostOutcome = 'failed';
		try {
			const afterByRepository = new Map(after.map(state => [state.repository.toString(), state.ref]));
			const files = [];
			const errors: string[] = [];
			const addError = (message: string) => {
				if (retain) {
					this._reserveRetained(state, tracker, 64 + 2 * message.length);
				}
				errors.push(message);
			};
			for (const [repositoryIndex, beforeRepository] of before.entries()) {
				const afterRef = afterByRepository.get(beforeRepository.repository.toString());
				if (!afterRef) {
					addError(`Missing latest state for repository ${beforeRepository.repository.toString()}`);
					continue;
				}
				const diffs = await this._gitService.computeFileDiffsBetweenRefs(beforeRepository.repository, {
					sessionUri: session,
					fromRef: beforeRepository.ref,
					toRef: afterRef,
				});
				this._assertActive(state);
				if (!diffs) {
					addError(`Failed to compute diff for repository ${beforeRepository.repository.toString()}`);
					continue;
				}
				for (const [fileIndex, diff] of diffs.entries()) {
					const retainedBytesBeforeFile = tracker.retainedBytes;
					const fileCost = cost.createFile(comparison, repositoryIndex, fileIndex);
					try {
						const materialized = await this._materializeFileDiff(beforeRepository.repository, beforeRepository.ref, afterRef, diff, budget, state, tracker, retain, fileCost);
						files.push(materialized);
						this._sizeEvent(tracker, { phase: 'fileConstruction', status: 'completed', ...this._fileSizeDetails(fileCost) });
					} catch (error) {
						const fileOutcome = getRequestDiffSurvivalCostOutcome(error);
						if (!fileCost.computationStarted) {
							cost.fileNotStarted(fileCost, fileOutcome);
						}
						this._sizeEvent(tracker, { phase: 'fileConstruction', status: fileOutcome, ...this._fileSizeDetails(fileCost) });
						if (error instanceof RequestDiffSurvivalBudgetError || isCancellationError(error)) {
							throw error;
						}
						this._assertActive(state);
						if (retain) {
							const released = tracker.retainedBytes - retainedBytesBeforeFile;
							this._retainedBytes -= released;
							tracker.retainedBytes = retainedBytesBeforeFile;
							this._sizeEvent(tracker, { phase: 'rollback', status: 'failed', retainedBytesDelta: -released, ...this._fileSizeDetails(fileCost) });
						}
						const message = `Failed to materialize ${diff.after?.uri ?? diff.before?.uri ?? 'unknown file'}: ${error instanceof Error ? error.message : String(error)}`;
						addError(message);
					}
				}
			}
			outcome = errors.length > 0 ? 'failed' : 'completed';
			return { files, errors };
		} catch (error) {
			outcome = getRequestDiffSurvivalCostOutcome(error);
			throw error;
		} finally {
			cost.finishComparison(comparison, outcome);
		}
	}

	private async _materializeFileDiff(
		repository: URI, beforeRef: string, afterRef: string, diff: ISessionFileDiff,
		budget: RequestDiffSurvivalInputBudget, state: IRequestDiffSurvivalState,
		tracker: IRequestDiffSurvivalTracker, retain: boolean, fileCost: IRequestDiffSurvivalFileCost,
	) {
		const beforePath = diff.before ? relativePath(repository, URI.parse(diff.before.uri)) : undefined;
		const afterPath = diff.after ? relativePath(repository, URI.parse(diff.after.uri)) : undefined;
		if ((diff.before && !beforePath) || (diff.after && !afterPath)) {
			throw new Error('Diff path is not a repository-relative file');
		}
		const [beforeSize, afterSize] = await Promise.all([
			beforePath ? this._gitService.getBlobSize(repository, beforeRef, beforePath) : 0,
			afterPath ? this._gitService.getBlobSize(repository, afterRef, afterPath) : 0,
		]);
		this._assertActive(state);
		if (beforeSize === undefined || afterSize === undefined || !Number.isSafeInteger(beforeSize) || !Number.isSafeInteger(afterSize) || beforeSize < 0 || afterSize < 0) {
			this._sizeEvent(tracker, { phase: 'inputCheck', status: 'failed', ...this._fileSizeDetails(fileCost) });
			throw new Error('Unable to read Git blob size');
		}
		const fileInputBytes = beforeSize + afterSize;
		fileCost.fileInputBytes = fileInputBytes;
		try {
			budget.consume(fileInputBytes);
		} catch (error) {
			if (error instanceof RequestDiffSurvivalBudgetError) {
				this._sizeEvent(tracker, {
					phase: 'budgetRejection', status: 'budgetRejected', ...this._fileSizeDetails(fileCost),
					proposedObservationInputBytes: error.diagnostics.observationInputBytes,
				});
			}
			throw error;
		}
		this._sizeEvent(tracker, { phase: 'inputCheck', status: 'completed', ...this._fileSizeDetails(fileCost) });
		const originalPath = beforePath ? `${repository.toString()}#${beforePath}` : undefined;
		const modifiedPath = afterPath ? `${repository.toString()}#${afterPath}` : undefined;
		if (retain) {
			// Charge source strings too: sliced change text can retain their backing storage.
			this._reserveRetained(state, tracker, 256 + 2 * fileInputBytes + 2 * ((originalPath?.length ?? 0) + (modifiedPath?.length ?? 0)), fileCost);
		}
		const [before, after] = await Promise.all([
			beforePath ? this._gitService.showBlob(repository, beforeRef, beforePath) : undefined,
			afterPath ? this._gitService.showBlob(repository, afterRef, afterPath) : undefined,
		]);
		this._assertActive(state);
		if (beforePath && !before) {
			throw new Error(`Missing before blob ${beforeRef}:${beforePath}`);
		}
		if (afterPath && !after) {
			throw new Error(`Missing after blob ${afterRef}:${afterPath}`);
		}
		if ((before?.byteLength ?? 0) !== beforeSize || (after?.byteLength ?? 0) !== afterSize) {
			throw new Error('Git blob contents do not match preflight sizes');
		}
		const originalText = before?.toString() ?? '';
		const modifiedText = after?.toString() ?? '';
		fileCost.beforeUtf16Length = originalText.length;
		fileCost.afterUtf16Length = modifiedText.length;
		return tracker.cost.measureFile(fileCost, () => computeRequestCharacterDiffFile(originalPath, modifiedPath, originalText, modifiedText,
			retain ? (path, length) => this._reserveRetained(state, tracker, 128 + 2 * (path.length + length), fileCost) : undefined));
	}
}
