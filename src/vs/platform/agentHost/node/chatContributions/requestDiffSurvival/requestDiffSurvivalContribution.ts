/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler, SequencerByKey } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { CancellationError, isCancellationError } from '../../../../../base/common/errors.js';
import { isEqualOrParent, relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILogService } from '../../../../log/common/log.js';
import { IAgentHostCheckpointService } from '../../../common/agentHostCheckpointService.js';
import { createChatMementoKey, type IAgentHostChatContribution, type IAgentHostChatContributionContext, type IDispatchedAction, type IOutgoingTurn, type ITurnEnd } from '../../../common/agentHostChatContributionsService.js';
import { IAgentHostGitService } from '../../../common/agentHostGitService.js';
import { DEFAULT_DIFF_TIMEOUT_MS, IDiffComputeService } from '../../../common/diffComputeService.js';
import { CLAUDE_AGENT_PROVIDER_ID, COPILOT_CLI_AGENT_PROVIDER_ID } from '../../../common/agent.js';
import { readToolCallMeta } from '../../../common/meta/agentToolCallMeta.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import type { ISessionFileDiff, URI as ProtocolURI } from '../../../common/state/sessionState.js';
import { AgentHostStateManager, IAgentHostStateManager } from '../../agentHostStateManager.js';
import { computeRequestCharacterDiffSurvivalMetric, materializeRequestCharacterDiffFile, type IRequestCharacterRepositoryDiff } from './requestCharacterDiffSurvival.js';
import { RequestDiffSurvivalBudgetError, RequestDiffSurvivalInputBudget, requestDiffSurvivalLimits } from './requestDiffSurvivalLimits.js';
import { getRequestDiffSurvivalCostOutcome, RequestDiffSurvivalComputationError, RequestDiffSurvivalCostObservation, type IRequestDiffSurvivalFileCost, type IRequestDiffSurvivalSizeDetails, type RequestDiffSurvivalComparison, type RequestDiffSurvivalCostOutcome } from './requestDiffSurvivalCost.js';
import { RequestDiffSurvivalDiagnostics } from './requestDiffSurvivalDiagnostics.js';

const CHARACTER_DIFF_LOG_PREFIX = '[RequestCharacterDiffSurvivalObservation] ';
const ENABLED_ENVIRONMENT_VARIABLE = 'VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG';

type ExpiryReason = 'idleExpired' | 'maximumAgeExceeded';
type UnavailableReason = 'repositoryBusy' | 'repositoryActivity' | 'captureFailed' | 'computationFailed' | 'initialObservationIncomplete' | 'observationInProgress';

/** Couples deadline scheduling with a monotonic clock; tests override this dependency. */
export class RequestDiffSurvivalExpiryScheduler extends RunOnceScheduler {
	now(): number {
		return performance.now();
	}
}

interface IRepositoryState {
	readonly repository: URI;
	readonly ref: string;
}

interface IPreparedFileInput {
	readonly beforePath: string | undefined;
	readonly afterPath: string | undefined;
	readonly beforeSize: number;
	readonly afterSize: number;
}

interface IPreparedComparison {
	readonly files: {
		readonly repository: URI;
		readonly beforeRef: string;
		readonly afterRef: string;
		readonly diff: ISessionFileDiff;
		readonly cost: IRequestDiffSurvivalFileCost;
		readonly input: IPreparedFileInput | Error;
	}[];
	readonly errors: string[];
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
	initialObservationReady: boolean;
	readonly baseModel: string | null;
	readonly baseStartTimestamp: string;
	readonly baseEndTimestamp: string;
	readonly originalRequestUsedEditTool: boolean | null;
	observationCount: number;
	cost: RequestDiffSurvivalCostObservation;
	readonly endedAt: number;
	lastObservationRequestId: string;
	lastObservationModel: string | null;
	expiryReason?: ExpiryReason;
	isObserving: boolean;
	isRetired: boolean;
}

interface IRequestDiffSurvivalState {
	readonly starts: Map<string, IRequestDiffSurvivalRequestStart>;
	readonly requestEvidence: Map<string, IRequestEditToolEvidence>;
	readonly toolRequests: Map<string, { readonly chat: ProtocolURI; readonly turnId: string }>;
	readonly trackers: IRequestDiffSurvivalTracker[];
	readonly activeTurns: Map<string, readonly URI[] | undefined>;
	session?: ProtocolURI;
	lastActivity: number;
	isDisposed: boolean;
	diagnosticTaskId?: number;
}

interface IRequestEditToolEvidence {
	readonly supported: boolean;
	readonly tools: Map<ProtocolURI, Map<string, boolean | undefined>>;
}

interface IRequestCharacterDiffSurvivalObservation {
	readonly schemaVersion: 6;
	readonly storageStrategy: 'checkpointIds';
	readonly engine: 'worker-hybrid';
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
	readonly observationBoundary: 'requestEnd' | 'expiry';
	readonly observationIndex: number;
	readonly maximumObservationCount: number;
	readonly maximumFollowUpCount: number;
	readonly isFinalObservation: boolean;
	readonly complete: boolean;
	readonly status: 'measured' | 'budgetExceeded' | 'unavailable';
	readonly terminalReason?: ExpiryReason;
	readonly unavailableReason?: UnavailableReason;
	readonly fileInputBudgetExceeded: 0 | 1;
	readonly observationInputBudgetExceeded: 0 | 1;
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
	private readonly _diagnostics: RequestDiffSurvivalDiagnostics | undefined;
	private readonly _observations = new SequencerByKey<ProtocolURI>();
	private readonly _states = new Map<ProtocolURI, IRequestDiffSurvivalState>();
	protected readonly _expiryScheduler = this._register(this._createExpiryScheduler(() => this._expireTrackers()));
	private _activityVersion = 0;
	private readonly _stateKey = createChatMementoKey<IRequestDiffSurvivalState>('requestDiffSurvival.state', () => ({
		starts: new Map(), requestEvidence: new Map(), toolRequests: new Map(), trackers: [], isDisposed: false,
		activeTurns: new Map(), lastActivity: this._expiryScheduler.now(),
	}), state => this._disposeState(state));

	private _disposeState(state: IRequestDiffSurvivalState): void {
		if (state.isDisposed) {
			return;
		}
		state.isDisposed = true;
		for (const [chat, candidate] of this._states) {
			if (candidate === state) {
				this._states.delete(chat);
			}
		}
		for (const tracker of [...state.trackers]) {
			this._retireTracker(state, tracker, 'stateDisposed');
		}
		state.starts.clear();
		state.requestEvidence.clear();
		state.toolRequests.clear();
		state.activeTurns.clear();
		this._scheduleExpiry();
	}

	protected _createExpiryScheduler(runner: () => void): RequestDiffSurvivalExpiryScheduler {
		return new RequestDiffSurvivalExpiryScheduler(runner, 0);
	}

	override dispose(): void {
		for (const state of [...this._states.values()]) {
			this._disposeState(state);
		}
		super.dispose();
	}

	constructor(
		protected readonly _context: IAgentHostChatContributionContext,
		@ILogService private readonly _logService: ILogService,
		@IAgentHostCheckpointService private readonly _checkpointService: IAgentHostCheckpointService,
		@IAgentHostGitService private readonly _gitService: IAgentHostGitService,
		@IAgentHostStateManager private readonly _stateManager: AgentHostStateManager,
		@IDiffComputeService private readonly _diffComputeService: IDiffComputeService,
	) {
		super();
		if (process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_DIAGNOSTICS === '1') {
			this._diagnostics = this._register(new RequestDiffSurvivalDiagnostics(this._enabled ? 'worker-hybrid' : 'disabled', this._logService));
		}
		if (this._enabled) {
			this._logService.info('[RequestDiffSurvival] Enabled for Agent Host chats; engine=worker-hybrid');
		}
	}

	onOutgoingTurn(turn: IOutgoingTurn): undefined {
		if (!this._enabled || this._store.isDisposed) {
			return undefined;
		}
		this._expireTrackers();
		const state = this._state(turn.chat, turn.session);
		state.lastActivity = this._expiryScheduler.now();
		state.activeTurns.set(turn.turnId, turn.workingDirectories);
		this._activityVersion++;
		this._scheduleExpiry();
		if (!state.requestEvidence.has(turn.turnId)) {
			const provider = this._stateManager.getSessionState(turn.session)?.provider;
			state.requestEvidence.set(turn.turnId, {
				supported: provider === COPILOT_CLI_AGENT_PROVIDER_ID || provider === CLAUDE_AGENT_PROVIDER_ID,
				tools: new Map(),
			});
		}
		const observationModel = turn.message.model?.id ?? turn.effectiveModel?.id ?? null;
		const observationTimestamp = new Date().toISOString();
		this._schedule(turn.session, turn.chat, state, turn.turnId, 'turnStart', async () => {
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
		if (!this._enabled || this._store.isDisposed || dispatched.rejectionReason) {
			return;
		}
		const { action } = dispatched;
		if (action.type === ActionType.ChatTurnStarted) {
			this._activityVersion++;
			return;
		}
		if (action.type !== ActionType.ChatToolCallStart
			&& action.type !== ActionType.ChatToolCallReady
			&& action.type !== ActionType.ChatToolCallComplete
			&& action.type !== ActionType.ChatToolCallConfirmed) {
			return;
		}
		this._activityVersion++;
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
		if (!this._enabled || this._store.isDisposed || !turn.turnId) {
			return;
		}
		this._expireTrackers();
		const state = this._state(turn.channel, turn.session);
		const endedAt = this._expiryScheduler.now();
		state.lastActivity = endedAt;
		state.activeTurns.delete(turn.turnId);
		this._activityVersion++;
		this._scheduleExpiry();
		if (!this._tracksTurnEnd(turn)) {
			return;
		}
		const turnId = turn.turnId;
		this._diagnostics?.noteEligibleTurnEnd();
		const originalRequestUsedEditTool = this._finishEvidence(turn.channel, turnId);
		const observationTimestamp = new Date().toISOString();
		this._schedule(turn.session, turn.channel, state, turnId, 'turnEnd', async () => {
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
				initialObservationReady: false,
				baseModel: start.model,
				baseStartTimestamp: start.timestamp,
				baseEndTimestamp: observationTimestamp,
				originalRequestUsedEditTool,
				observationCount: 0,
				endedAt,
				lastObservationRequestId: turnId,
				lastObservationModel: start.model,
				isObserving: false,
				isRetired: false,
				cost: new RequestDiffSurvivalCostObservation(this._logService, {
					sessionId: turn.session, chatId: turn.channel, originatingRequestId: turnId,
					observationRequestId: turnId, observationIndex: 0,
				}),
			};
			state.trackers.push(tracker);
			this._expireTrackers();
			await this._emitObservation(turn.session, turn.channel, turnId, start.model, observationTimestamp, result, tracker, state);
			state.starts.delete(turnId);
			this._scheduleExpiry();
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

	private _schedule(sessionId: ProtocolURI, chat: ProtocolURI, state: IRequestDiffSurvivalState, requestId: string, taskKind: 'turnStart' | 'turnEnd', task: () => Promise<void>): void {
		const diagnosticTask = this._diagnostics?.enqueueTask({ sessionId, chatId: chat, requestId, taskKind });
		void this._observations.queue(chat, async () => {
			diagnosticTask?.start();
			state.diagnosticTaskId = diagnosticTask?.id;
			let outcome: RequestDiffSurvivalCostOutcome = 'completed';
			try {
				this._assertActive(state);
				await task();
			} catch (error) {
				outcome = getRequestDiffSurvivalCostOutcome(error);
				throw error;
			} finally {
				state.diagnosticTaskId = undefined;
				diagnosticTask?.finish(outcome);
			}
		}).catch(error => this._handleObservationError(chat, error));
	}

	private _handleObservationError(chat: ProtocolURI, error: unknown): void {
		if (!isCancellationError(error)) {
			this._logService.warn(`[RequestDiffSurvival] Observation failed for ${chat}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private _state(chat: ProtocolURI, session?: ProtocolURI): IRequestDiffSurvivalState {
		const state = this._context.memento(this._stateKey, chat).get();
		state.session ??= session;
		this._states.set(chat, state);
		return state;
	}

	private _assertActive(state: IRequestDiffSurvivalState): void {
		if (state.isDisposed || this._store.isDisposed) {
			throw new CancellationError();
		}
	}

	private _assertTrackerActive(state: IRequestDiffSurvivalState, tracker: IRequestDiffSurvivalTracker, expiryReason?: ExpiryReason): void {
		this._assertActive(state);
		if (tracker.isRetired || tracker.expiryReason !== expiryReason) {
			throw new CancellationError();
		}
	}

	private _scheduleExpiry(): void {
		this._expiryScheduler.cancel();
		if (this._store.isDisposed) {
			return;
		}
		let deadline = Infinity;
		for (const state of this._states.values()) {
			for (const tracker of state.trackers) {
				if (!tracker.expiryReason) {
					deadline = Math.min(deadline, tracker.endedAt + requestDiffSurvivalLimits.maximumTrackerAgeMs);
					if (state.activeTurns.size === 0) {
						deadline = Math.min(deadline, state.lastActivity + requestDiffSurvivalLimits.idleExpiryMs);
					}
				}
			}
		}
		if (deadline !== Infinity) {
			this._expiryScheduler.schedule(Math.max(0, deadline - this._expiryScheduler.now()));
		}
	}

	private _expireTrackers(): void {
		const now = this._expiryScheduler.now();
		for (const [chat, state] of this._states) {
			for (const tracker of [...state.trackers]) {
				if (tracker.expiryReason || tracker.isRetired) {
					continue;
				}
				const reason = now - tracker.endedAt >= requestDiffSurvivalLimits.maximumTrackerAgeMs ? 'maximumAgeExceeded'
					: state.activeTurns.size === 0 && now - state.lastActivity >= requestDiffSurvivalLimits.idleExpiryMs ? 'idleExpired' : undefined;
				if (!reason) {
					continue;
				}
				tracker.expiryReason = reason;
				try {
					if (tracker.isObserving || !tracker.initialObservationReady || this._repositoryBusy(tracker.baseline)) {
						if (!tracker.isObserving) {
							this._prepareExpiryCost(state, chat, tracker);
						}
						this._writeUnavailableExpiry(state, chat, tracker, tracker.isObserving ? 'observationInProgress'
							: !tracker.initialObservationReady ? 'initialObservationIncomplete' : 'repositoryBusy');
					} else {
						void this._finalizeExpiry(state, chat, tracker, reason)
							.finally(() => this._retireTracker(state, tracker, reason))
							.catch(error => this._handleObservationError(chat, error));
					}
				} catch (error) {
					this._retireTracker(state, tracker, reason);
					this._handleObservationError(chat, error);
				}
			}
		}
		this._scheduleExpiry();
	}

	private _repositoryBusy(repositories: readonly IRepositoryState[]): boolean {
		for (const state of this._states.values()) {
			for (const [turnId, directories] of state.activeTurns) {
				const roots = directories ?? state.starts.get(turnId)?.repositories.map(repository => repository.repository);
				if (!roots || roots.some(root => repositories.some(repository =>
					isEqualOrParent(root, repository.repository) || isEqualOrParent(repository.repository, root)))) {
					return true;
				}
			}
		}
		for (const session of this._stateManager.getSessionUris()) {
			for (const chat of this._stateManager.getSessionState(session)?.chats ?? []) {
				const turnId = this._stateManager.getActiveTurnId(chat.resource);
				if (turnId && !this._states.get(chat.resource)?.activeTurns.has(turnId)) {
					return true;
				}
			}
		}
		return false;
	}

	private _prepareExpiryCost(state: IRequestDiffSurvivalState, chat: ProtocolURI, tracker: IRequestDiffSurvivalTracker): void {
		if (!state.session) {
			throw new Error('Missing session for request survival expiry');
		}
		tracker.cost = new RequestDiffSurvivalCostObservation(this._logService, {
			sessionId: state.session, chatId: chat, originatingRequestId: tracker.originatingRequestId,
			observationRequestId: tracker.lastObservationRequestId, observationIndex: tracker.observationCount,
		});
	}

	private _writeUnavailableExpiry(state: IRequestDiffSurvivalState, chat: ProtocolURI, tracker: IRequestDiffSurvivalTracker, reason: UnavailableReason): void {
		try {
			if (!state.session || !tracker.expiryReason) {
				throw new Error('Missing request survival expiry identity');
			}
			this._writeObservation(state.session, chat, tracker.lastObservationRequestId, tracker.lastObservationModel,
				new Date().toISOString(), tracker, undefined, undefined, tracker.expiryReason, reason);
		} finally {
			if (!tracker.isObserving) {
				tracker.cost.finishObservation('failed');
				this._sizeEvent(tracker, { phase: 'observation', status: 'failed' });
			}
			this._retireTracker(state, tracker, tracker.expiryReason ?? 'failed');
		}
	}

	private async _finalizeExpiry(state: IRequestDiffSurvivalState, chat: ProtocolURI, tracker: IRequestDiffSurvivalTracker, reason: ExpiryReason): Promise<void> {
		if (!state.session) {
			throw new Error('Missing session for request survival expiry');
		}
		const diagnosticTask = this._diagnostics?.enqueueTask({
			sessionId: state.session, chatId: chat, requestId: tracker.lastObservationRequestId, taskKind: 'expiry',
		});
		diagnosticTask?.start();
		let outcome: RequestDiffSurvivalCostOutcome = 'completed';
		try {
			await this._captureAndFinalizeExpiry(state, chat, tracker, reason, diagnosticTask?.id);
		} catch (error) {
			outcome = getRequestDiffSurvivalCostOutcome(error);
			throw error;
		} finally {
			diagnosticTask?.finish(outcome);
		}
	}

	private async _captureAndFinalizeExpiry(state: IRequestDiffSurvivalState, chat: ProtocolURI, tracker: IRequestDiffSurvivalTracker, reason: ExpiryReason, diagnosticTaskId?: number): Promise<void> {
		if (tracker.isRetired) {
			return;
		}
		this._prepareExpiryCost(state, chat, tracker);
		let latest: readonly IRepositoryState[] | UnavailableReason;
		try {
			latest = await this._captureExpiryState(state, tracker, reason);
		} catch (error) {
			if (isCancellationError(error) && (state.isDisposed || tracker.isRetired)) {
				return;
			}
			this._logService.warn(`[RequestDiffSurvival] Expiry capture failed for ${chat}`, error);
			this._writeUnavailableExpiry(state, chat, tracker, 'captureFailed');
			return;
		}
		if (typeof latest === 'string') {
			this._writeUnavailableExpiry(state, chat, tracker, latest);
			return;
		}
		const session = state.session;
		if (!session) {
			throw new Error('Missing session for request survival expiry');
		}
		await this._emitObservation(session, chat, tracker.lastObservationRequestId, tracker.lastObservationModel,
			new Date().toISOString(), latest, tracker, state, reason, diagnosticTaskId);
	}

	private async _captureExpiryState(state: IRequestDiffSurvivalState, tracker: IRequestDiffSurvivalTracker, reason: ExpiryReason): Promise<readonly IRepositoryState[] | UnavailableReason> {
		const version = this._activityVersion;
		const latest: IRepositoryState[] = [];
		for (const { repository } of tracker.baseline) {
			if (this._repositoryBusy(tracker.baseline)) {
				return 'repositoryBusy';
			}
			const ref = await this._gitService.captureWorkingTreeAsTree(repository);
			this._assertTrackerActive(state, tracker, reason);
			if (version !== this._activityVersion || this._repositoryBusy(tracker.baseline)) {
				return 'repositoryActivity';
			}
			if (!ref) {
				this._logService.warn(`[RequestDiffSurvival] Failed to capture expiry state for ${tracker.originatingRequestId}`);
				return 'captureFailed';
			}
			latest.push({ repository, ref });
		}
		return latest;
	}

	private _retireTracker(
		state: IRequestDiffSurvivalState, tracker: IRequestDiffSurvivalTracker,
		reason: NonNullable<IRequestDiffSurvivalSizeDetails['reason']>,
	): void {
		const index = state.trackers.indexOf(tracker);
		if (index >= 0) {
			state.trackers.splice(index, 1);
		}
		tracker.isRetired = true;
		if (index >= 0) {
			this._sizeEvent(tracker, { phase: 'retirement', status: 'completed', reason });
		}
		this._scheduleExpiry();
	}

	private _sizeEvent(
		tracker: IRequestDiffSurvivalTracker,
		details: IRequestDiffSurvivalSizeDetails,
	): void {
		tracker.cost.size(details);
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
			const tree = await this._gitService.revParse(repository, `${pair.current}^{tree}`);
			if (!tree) {
				this._logService.warn(`[RequestDiffSurvival] Cannot resolve Git end checkpoint ${pair.current}`);
				return undefined;
			}
			result.push({ repository, ref: tree });
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
			this._expireTrackers();
			if (tracker.isRetired || tracker.expiryReason) {
				continue;
			}
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
		expiryReason?: ExpiryReason,
		diagnosticTaskId = state.diagnosticTaskId,
	): Promise<void> {
		if (tracker.isRetired || tracker.expiryReason !== expiryReason) {
			return;
		}
		tracker.lastObservationRequestId = observationRequestId;
		tracker.lastObservationModel = observationModel;
		tracker.isObserving = true;
		const cost = expiryReason || tracker.observationCount === 0 ? tracker.cost : tracker.cost = new RequestDiffSurvivalCostObservation(this._logService, {
			sessionId: session, chatId: chat, originatingRequestId: tracker.originatingRequestId,
			observationRequestId, observationIndex: tracker.observationCount,
		});
		let outcome: RequestDiffSurvivalCostOutcome = 'failed';
		let attemptedWrite = false;
		const finishDiagnostics = this._diagnostics?.startObservation({
			sessionId: session, chatId: chat, originatingRequestId: tracker.originatingRequestId,
			observationRequestId, observationIndex: tracker.observationCount, observationBoundary: expiryReason ? 'expiry' : 'requestEnd',
		}, diagnosticTaskId);
		try {
			const budget = cost.inputBudget;
			const originalInput = await this._preflightDiff(session, tracker.baseline, tracker.requestResult, budget, state, tracker, 'originalRequest');
			const baselineInput = tracker.observationCount > 0
				? await this._preflightDiff(session, tracker.baseline, latest, budget, state, tracker, 'baselineToLatest')
				: undefined;
			const resultInput = tracker.observationCount > 0
				? await this._preflightDiff(session, tracker.requestResult, latest, budget, state, tracker, 'requestResultToLatest')
				: undefined;
			this._assertTrackerActive(state, tracker, expiryReason);
			const originalRequest = await this._computeDiff(originalInput, state, tracker, 'originalRequest');
			const baselineToLatest = baselineInput
				? await this._computeDiff(baselineInput, state, tracker, 'baselineToLatest')
				: originalRequest;
			const requestResultToLatest = resultInput
				? await this._computeDiff(resultInput, state, tracker, 'requestResultToLatest')
				: { files: [], errors: [] };
			if (tracker.observationCount === 0) {
				cost.finishComparison('baselineToLatest', 'reused');
				cost.finishComparison('requestResultToLatest', 'empty');
			}
			this._assertTrackerActive(state, tracker, expiryReason);
			outcome = [originalRequest, baselineToLatest, requestResultToLatest].some(diff => diff.errors.length > 0) ? 'failed' : 'completed';
			attemptedWrite = true;
			this._writeObservation(session, chat, observationRequestId, observationModel, observationTimestamp, tracker, {
				originalRequest, baselineToLatest, requestResultToLatest,
			}, undefined, expiryReason, expiryReason && outcome === 'failed' ? 'computationFailed' : undefined);
			tracker.initialObservationReady = true;
			tracker.observationCount++;
			if (expiryReason || tracker.observationCount > requestDiffSurvivalLimits.maximumFollowUpCount) {
				this._retireTracker(state, tracker, expiryReason ?? 'horizon');
			}
		} catch (error) {
			outcome = getRequestDiffSurvivalCostOutcome(error);
			if (isCancellationError(error) && (tracker.isRetired || tracker.expiryReason !== expiryReason)) {
				return;
			}
			if (expiryReason && attemptedWrite) {
				this._retireTracker(state, tracker, expiryReason);
				throw error;
			}
			if (error instanceof RequestDiffSurvivalBudgetError) {
				this._assertActive(state);
				this._writeObservation(session, chat, observationRequestId, observationModel, observationTimestamp, tracker, undefined, error, expiryReason);
				this._retireTracker(state, tracker, 'budgetRejected');
			} else if (error instanceof RequestDiffSurvivalComputationError && !state.isDisposed && !tracker.isRetired) {
				this._logService.warn(`[RequestDiffSurvival] Worker computation failed for ${chat}`, error);
				this._writeObservation(session, chat, observationRequestId, observationModel, observationTimestamp, tracker, undefined, undefined, expiryReason, 'computationFailed');
				this._retireTracker(state, tracker, expiryReason ?? 'failed');
			} else if (expiryReason && !state.isDisposed && !this._store.isDisposed) {
				this._logService.warn(`[RequestDiffSurvival] Expiry computation failed for ${chat}`, error);
				this._writeObservation(session, chat, observationRequestId, observationModel, observationTimestamp, tracker, undefined, undefined, expiryReason, 'computationFailed');
				this._retireTracker(state, tracker, expiryReason);
			} else {
				this._retireTracker(state, tracker, isCancellationError(error) ? 'cancelled' : 'failed');
				throw error;
			}
		} finally {
			cost.finishObservation(outcome);
			this._sizeEvent(tracker, { phase: 'observation', status: outcome });
			tracker.isObserving = false;
			this._scheduleExpiry();
			finishDiagnostics?.(outcome);
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
		expiryReason?: ExpiryReason,
		unavailableReason?: UnavailableReason,
	): void {
		if (unavailableReason) {
			diffs = undefined;
		}
		const observation: IRequestCharacterDiffSurvivalObservation = {
			schemaVersion: 6,
			storageStrategy: 'checkpointIds',
			engine: 'worker-hybrid',
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
			observationBoundary: expiryReason ? 'expiry' : 'requestEnd',
			observationIndex: tracker.observationCount,
			maximumObservationCount: requestDiffSurvivalLimits.maximumFollowUpCount + 1,
			maximumFollowUpCount: requestDiffSurvivalLimits.maximumFollowUpCount,
			isFinalObservation: !!expiryReason || !!error || !!unavailableReason || tracker.observationCount === requestDiffSurvivalLimits.maximumFollowUpCount,
			complete: !!diffs && Object.values(diffs).every(diff => diff.errors.length === 0),
			status: error ? 'budgetExceeded' : unavailableReason ? 'unavailable' : 'measured',
			terminalReason: expiryReason,
			unavailableReason,
			fileInputBudgetExceeded: error?.fileInputBudgetExceeded ? 1 : 0,
			observationInputBudgetExceeded: error?.observationInputBudgetExceeded ? 1 : 0,
			limits: requestDiffSurvivalLimits,
			budgetDiagnostics: error?.diagnostics,
			diffs,
			survival: diffs ? computeRequestCharacterDiffSurvivalMetric(diffs.originalRequest, diffs.baselineToLatest, diffs.requestResultToLatest) : {
				survivingAdditions: -1, survivingDeletions: -1, totalAdditions: -1, totalDeletions: -1, totalSurviving: -1, totalEdits: -1, ratio: -1,
			},
		};
		this._logService.info(`${CHARACTER_DIFF_LOG_PREFIX}${JSON.stringify(observation)}`);
	}

	private async _preflightDiff(
		session: ProtocolURI,
		before: readonly IRepositoryState[],
		after: readonly IRepositoryState[],
		budget: RequestDiffSurvivalInputBudget,
		state: IRequestDiffSurvivalState,
		tracker: IRequestDiffSurvivalTracker,
		comparison: RequestDiffSurvivalComparison,
	): Promise<IPreparedComparison> {
		const cost = tracker.cost;
		const expiryReason = tracker.expiryReason;
		const prepared: IPreparedComparison = { files: [], errors: [] };
		try {
			const afterByRepository = new Map(after.map(state => [state.repository.toString(), state.ref]));
			for (const [repositoryIndex, beforeRepository] of before.entries()) {
				const afterRef = afterByRepository.get(beforeRepository.repository.toString());
				if (!afterRef) {
					prepared.errors.push(`Missing latest state for repository ${beforeRepository.repository.toString()}`);
					continue;
				}
				const diffs = await this._gitService.computeFileDiffsBetweenRefs(beforeRepository.repository, {
					sessionUri: session,
					fromRef: beforeRepository.ref,
					toRef: afterRef,
				});
				this._assertTrackerActive(state, tracker, expiryReason);
				if (!diffs) {
					prepared.errors.push(`Failed to compute diff for repository ${beforeRepository.repository.toString()}`);
					continue;
				}
				for (const [fileIndex, diff] of diffs.entries()) {
					const fileCost = cost.createFile(comparison, repositoryIndex, fileIndex);
					let input: IPreparedFileInput | Error;
					try {
						input = await this._preflightFileInput(beforeRepository.repository, beforeRepository.ref, afterRef, diff, budget, state, tracker, fileCost, expiryReason);
					} catch (error) {
						if (error instanceof RequestDiffSurvivalBudgetError || isCancellationError(error)) {
							cost.fileNotStarted(fileCost, getRequestDiffSurvivalCostOutcome(error));
							throw error;
						}
						this._assertTrackerActive(state, tracker, expiryReason);
						input = error instanceof Error ? error : new Error(String(error));
						this._sizeEvent(tracker, { phase: 'inputCheck', status: 'failed', ...this._fileSizeDetails(fileCost) });
					}
					prepared.files.push({
						repository: beforeRepository.repository, beforeRef: beforeRepository.ref, afterRef, diff, cost: fileCost, input,
					});
				}
			}
			return prepared;
		} catch (error) {
			cost.finishComparison(comparison, getRequestDiffSurvivalCostOutcome(error));
			throw error;
		}
	}

	private async _preflightFileInput(
		repository: URI, beforeRef: string, afterRef: string, diff: ISessionFileDiff,
		budget: RequestDiffSurvivalInputBudget, state: IRequestDiffSurvivalState,
		tracker: IRequestDiffSurvivalTracker, fileCost: IRequestDiffSurvivalFileCost,
		expiryReason?: ExpiryReason,
	): Promise<IPreparedFileInput> {
		const beforePath = diff.before ? relativePath(repository, URI.parse(diff.before.uri)) : undefined;
		const afterPath = diff.after ? relativePath(repository, URI.parse(diff.after.uri)) : undefined;
		if ((diff.before && !beforePath) || (diff.after && !afterPath)) {
			throw new Error('Diff path is not a repository-relative file');
		}
		const [beforeSize, afterSize] = await Promise.all([
			beforePath ? this._gitService.getBlobSize(repository, beforeRef, beforePath) : 0,
			afterPath ? this._gitService.getBlobSize(repository, afterRef, afterPath) : 0,
		]);
		this._assertTrackerActive(state, tracker, expiryReason);
		if (beforeSize === undefined || afterSize === undefined || !Number.isSafeInteger(beforeSize) || !Number.isSafeInteger(afterSize) || beforeSize < 0 || afterSize < 0) {
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
		return { beforePath, afterPath, beforeSize, afterSize };
	}

	private async _computeDiff(
		prepared: IPreparedComparison,
		state: IRequestDiffSurvivalState,
		tracker: IRequestDiffSurvivalTracker,
		comparison: RequestDiffSurvivalComparison,
	): Promise<IRequestCharacterRepositoryDiff> {
		const cost = tracker.cost;
		const expiryReason = tracker.expiryReason;
		cost.beginComparison(comparison);
		let outcome: RequestDiffSurvivalCostOutcome = 'failed';
		const files = [];
		const errors: string[] = [];
		try {
			for (const error of prepared.errors) {
				errors.push(error);
			}
			for (const file of prepared.files) {
				this._assertTrackerActive(state, tracker, expiryReason);
				const fileCost = file.cost;
				try {
					if (file.input instanceof Error) {
						throw file.input;
					}
					files.push(await this._materializeFileDiff(file.repository, file.beforeRef, file.afterRef, file.input, state, tracker, fileCost, expiryReason));
					this._sizeEvent(tracker, { phase: 'fileConstruction', status: 'completed', ...this._fileSizeDetails(fileCost) });
				} catch (error) {
					const fileOutcome = getRequestDiffSurvivalCostOutcome(error);
					if (!fileCost.computationStarted) {
						cost.fileNotStarted(fileCost, fileOutcome);
					}
					this._sizeEvent(tracker, { phase: 'fileConstruction', status: fileOutcome, ...this._fileSizeDetails(fileCost) });
					if (error instanceof RequestDiffSurvivalBudgetError || error instanceof RequestDiffSurvivalComputationError || isCancellationError(error)) {
						throw error;
					}
					this._assertTrackerActive(state, tracker, expiryReason);
					errors.push(`Failed to materialize ${file.diff.after?.uri ?? file.diff.before?.uri ?? 'unknown file'}: ${error instanceof Error ? error.message : String(error)}`);
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
		repository: URI, beforeRef: string, afterRef: string, input: IPreparedFileInput,
		state: IRequestDiffSurvivalState, tracker: IRequestDiffSurvivalTracker,
		fileCost: IRequestDiffSurvivalFileCost, expiryReason?: ExpiryReason,
	) {
		const { beforePath, afterPath, beforeSize, afterSize } = input;
		const originalPath = beforePath ? `${repository.toString()}#${beforePath}` : undefined;
		const modifiedPath = afterPath ? `${repository.toString()}#${afterPath}` : undefined;
		const [before, after] = await Promise.all([
			beforePath ? this._gitService.showBlob(repository, beforeRef, beforePath) : undefined,
			afterPath ? this._gitService.showBlob(repository, afterRef, afterPath) : undefined,
		]);
		this._assertTrackerActive(state, tracker, expiryReason);
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
		return tracker.cost.measureWorkerFile(fileCost,
			() => this._diffComputeService.computeSurvivalDiff(originalText, modifiedText, DEFAULT_DIFF_TIMEOUT_MS),
			changes => {
				this._assertTrackerActive(state, tracker, expiryReason);
				return materializeRequestCharacterDiffFile(originalPath, modifiedPath, originalText, modifiedText, changes);
			});
	}
}
