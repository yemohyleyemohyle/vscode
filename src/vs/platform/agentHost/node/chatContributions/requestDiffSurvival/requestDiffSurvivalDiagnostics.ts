/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { monitorEventLoopDelay } from 'perf_hooks';
import { IntervalTimer } from '../../../../../base/common/async.js';
import { Disposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import type { ILogService } from '../../../../log/common/log.js';
import type { RequestDiffSurvivalCostOutcome } from './requestDiffSurvivalCost.js';

const LOG_PREFIX = '[RequestDiffSurvivalDiagnostics] ';
const WINDOW_INTERVAL_MS = 1000;
const LOOP_RESOLUTION_MS = 10;

interface ITaskIdentity {
	readonly sessionId: string;
	readonly chatId: string;
	readonly requestId: string;
	readonly taskKind: 'turnStart' | 'turnEnd' | 'expiry';
}

interface IObservationIdentity {
	readonly sessionId: string;
	readonly chatId: string;
	readonly originatingRequestId: string;
	readonly observationRequestId: string;
	readonly observationIndex: number;
	readonly observationBoundary: 'requestEnd' | 'expiry';
}

interface ICounts {
	queuedTaskCount: number;
	runningTaskCount: number;
	runningObservationCount: number;
	peakPendingTaskCount: number;
}

interface ITask {
	readonly identity: ITaskIdentity;
	readonly enqueuedAt: number;
	startedAt?: number;
}

/** Allows deterministic timing and histogram tests without replacing process globals. */
export interface IRequestDiffSurvivalDiagnosticsRuntime {
	now(): number;
	createLoopMonitor(): IDisposable & { read(): { sampleCount: number; p95Ms: number | null; maxMs: number | null }; reset(): void };
	scheduleWindow(callback: () => void): IDisposable;
}

const defaultRuntime: IRequestDiffSurvivalDiagnosticsRuntime = {
	now: () => performance.now(),
	createLoopMonitor: () => {
		const histogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
		histogram.enable();
		return {
			read: () => ({
				sampleCount: histogram.count,
				p95Ms: histogram.count > 0 ? histogram.percentile(95) / 1e6 : null,
				maxMs: histogram.count > 0 ? histogram.max / 1e6 : null,
			}),
			reset: () => histogram.reset(),
			dispose: () => histogram.disable(),
		};
	},
	scheduleWindow: callback => {
		const timer = new IntervalTimer();
		timer.cancelAndSet(callback, WINDOW_INTERVAL_MS);
		return timer;
	},
};

type DiagnosticDetails =
	| { readonly phase: 'lifecycle'; readonly status: 'started' | 'stopped'; readonly windowIntervalMs: number; readonly loopResolutionMs: number; readonly unfinishedTaskCount: number; readonly unfinishedObservationCount: number }
	| { readonly phase: 'window'; readonly reason: 'interval' | 'dispose'; readonly windowElapsedMs: number; readonly eventLoop: { readonly status: 'available' | 'noSamples'; readonly sampleCount: number; readonly resolutionMs: number; readonly p95Ms: number | null; readonly maxMs: number | null }; readonly host: ICounts; readonly chats: readonly (ICounts & { readonly chatId: string })[] }
	| ({ readonly phase: 'task'; readonly taskId: number; readonly status: 'queued' | 'started' | RequestDiffSurvivalCostOutcome; readonly queueWaitMs: number | null; readonly processingElapsedMs: number | null; readonly totalElapsedMs: number; readonly host: ICounts; readonly chat: ICounts } & ITaskIdentity)
	| ({ readonly phase: 'observation'; readonly taskId: number | null; readonly status: RequestDiffSurvivalCostOutcome; readonly processingElapsedMs: number; readonly sinceTaskEnqueuedMs: number | null } & IObservationIdentity)
	| { readonly phase: 'drain'; readonly scope: 'survivalBackgroundWork'; readonly busyPeriodElapsedMs: number; readonly sinceLastEnqueueMs: number | null; readonly sinceLastEligibleTurnEndMs: number | null; readonly pendingTaskCount: 0; readonly runningObservationCount: 0 };

export type RequestDiffSurvivalDiagnosticRecord = DiagnosticDetails & {
	readonly recordKind: 'requestDiffSurvivalDiagnostics';
	readonly schemaVersion: 2;
	readonly storageStrategy: 'checkpointIds';
	readonly diagnosticsRunId: string;
	readonly sequence: number;
	readonly timestamp: string;
	readonly timeUnit: 'ms';
	readonly timingKind: 'elapsed';
	readonly engine: 'worker-hybrid' | 'disabled';
};

export interface IRequestDiffSurvivalDiagnosticTask {
	readonly id: number;
	start(): void;
	finish(status: RequestDiffSurvivalCostOutcome): void;
}

/** Collects local elapsed-time diagnostics independently of survival logging and its CPU measurements. */
export class RequestDiffSurvivalDiagnostics extends Disposable {
	static readonly logPrefix = LOG_PREFIX;
	private readonly _runId = generateUuid();
	private readonly _monitor;
	private readonly _host: ICounts = { queuedTaskCount: 0, runningTaskCount: 0, runningObservationCount: 0, peakPendingTaskCount: 0 };
	private readonly _chats = new Map<string, ICounts>();
	private readonly _tasks = new Map<number, ITask>();
	private _sequence = 0;
	private _nextTaskId = 0;
	private _windowStartedAt: number;
	private _busyStartedAt: number | undefined;
	private _lastEnqueueAt: number | undefined;
	private _lastEligibleTurnEndAt: number | undefined;

	constructor(
		private readonly _engine: 'worker-hybrid' | 'disabled',
		private readonly _logService: ILogService,
		private readonly _runtime: IRequestDiffSurvivalDiagnosticsRuntime = defaultRuntime,
	) {
		super();
		this._windowStartedAt = this._runtime.now();
		this._monitor = this._register(this._runtime.createLoopMonitor());
		this._write({ phase: 'lifecycle', status: 'started', windowIntervalMs: WINDOW_INTERVAL_MS, loopResolutionMs: LOOP_RESOLUTION_MS, unfinishedTaskCount: 0, unfinishedObservationCount: 0 });
		this._register(this._runtime.scheduleWindow(() => this._writeWindow('interval')));
	}

	noteEligibleTurnEnd(): void {
		this._lastEligibleTurnEndAt = this._runtime.now();
	}

	enqueueTask(identity: ITaskIdentity): IRequestDiffSurvivalDiagnosticTask {
		const id = ++this._nextTaskId;
		const task: ITask = { identity, enqueuedAt: this._runtime.now() };
		this._tasks.set(id, task);
		this._busyStartedAt ??= task.enqueuedAt;
		this._lastEnqueueAt = task.enqueuedAt;
		const chat = this._chat(identity.chatId);
		for (const counts of [this._host, chat]) {
			counts.queuedTaskCount++;
			counts.peakPendingTaskCount = Math.max(counts.peakPendingTaskCount, counts.queuedTaskCount + counts.runningTaskCount);
		}
		this._writeTask(id, task, 'queued', chat);
		return {
			id,
			start: () => {
				if (this._store.isDisposed || !this._tasks.has(id) || task.startedAt !== undefined) {
					return;
				}
				task.startedAt = this._runtime.now();
				for (const counts of [this._host, chat]) {
					counts.queuedTaskCount--;
					counts.runningTaskCount++;
				}
				this._writeTask(id, task, 'started', chat);
			},
			finish: status => {
				if (this._store.isDisposed || !this._tasks.delete(id)) {
					return;
				}
				for (const counts of [this._host, chat]) {
					if (task.startedAt === undefined) {
						counts.queuedTaskCount--;
					} else {
						counts.runningTaskCount--;
					}
				}
				this._writeTask(id, task, status, chat);
				this._removeIdleChat(identity.chatId, chat);
				this._writeDrainIfIdle();
			},
		};
	}

	startObservation(identity: IObservationIdentity, taskId?: number): (status: RequestDiffSurvivalCostOutcome) => void {
		const startedAt = this._runtime.now();
		const task = taskId === undefined ? undefined : this._tasks.get(taskId);
		const sinceTaskEnqueuedMs = task ? startedAt - task.enqueuedAt : null;
		this._busyStartedAt ??= startedAt;
		const chat = this._chat(identity.chatId);
		this._host.runningObservationCount++;
		chat.runningObservationCount++;
		let finished = false;
		return status => {
			if (this._store.isDisposed || finished) {
				return;
			}
			finished = true;
			this._host.runningObservationCount--;
			chat.runningObservationCount--;
			this._write({
				phase: 'observation', ...identity, taskId: taskId ?? null, status,
				processingElapsedMs: this._runtime.now() - startedAt, sinceTaskEnqueuedMs,
			});
			this._removeIdleChat(identity.chatId, chat);
			this._writeDrainIfIdle();
		};
	}

	private _chat(chatId: string): ICounts {
		let chat = this._chats.get(chatId);
		if (!chat) {
			chat = { queuedTaskCount: 0, runningTaskCount: 0, runningObservationCount: 0, peakPendingTaskCount: 0 };
			this._chats.set(chatId, chat);
		}
		return chat;
	}

	private _removeIdleChat(chatId: string, chat: ICounts): void {
		if (chat.queuedTaskCount === 0 && chat.runningTaskCount === 0 && chat.runningObservationCount === 0) {
			this._chats.delete(chatId);
		}
	}

	private _writeTask(taskId: number, task: ITask, status: 'queued' | 'started' | RequestDiffSurvivalCostOutcome, chat: ICounts): void {
		const now = this._runtime.now();
		this._write({
			phase: 'task', taskId, ...task.identity, status,
			queueWaitMs: task.startedAt === undefined ? null : task.startedAt - task.enqueuedAt,
			processingElapsedMs: status === 'queued' || status === 'started' || task.startedAt === undefined ? null : now - task.startedAt,
			totalElapsedMs: now - task.enqueuedAt, host: { ...this._host }, chat: { ...chat },
		});
	}

	private _writeWindow(reason: 'interval' | 'dispose'): void {
		const now = this._runtime.now();
		const sample = this._monitor.read();
		this._monitor.reset();
		this._write({
			phase: 'window', reason, windowElapsedMs: now - this._windowStartedAt,
			eventLoop: { ...sample, status: sample.sampleCount > 0 ? 'available' : 'noSamples', resolutionMs: LOOP_RESOLUTION_MS },
			host: { ...this._host }, chats: [...this._chats].map(([chatId, counts]) => ({ chatId, ...counts })),
		});
		this._windowStartedAt = now;
	}

	private _writeDrainIfIdle(): void {
		if (this._tasks.size > 0 || this._host.runningObservationCount > 0 || this._busyStartedAt === undefined) {
			return;
		}
		const now = this._runtime.now();
		this._write({
			phase: 'drain', scope: 'survivalBackgroundWork', busyPeriodElapsedMs: now - this._busyStartedAt,
			sinceLastEnqueueMs: this._lastEnqueueAt === undefined ? null : now - this._lastEnqueueAt,
			sinceLastEligibleTurnEndMs: this._lastEligibleTurnEndAt === undefined ? null : now - this._lastEligibleTurnEndAt,
			pendingTaskCount: 0, runningObservationCount: 0,
		});
		this._busyStartedAt = undefined;
	}

	private _write(details: DiagnosticDetails): void {
		const record: RequestDiffSurvivalDiagnosticRecord = {
			recordKind: 'requestDiffSurvivalDiagnostics', schemaVersion: 2, storageStrategy: 'checkpointIds', diagnosticsRunId: this._runId,
			sequence: ++this._sequence, timestamp: new Date().toISOString(), timeUnit: 'ms', timingKind: 'elapsed',
			engine: this._engine, ...details,
		};
		this._logService.info(`${LOG_PREFIX}${JSON.stringify(record)}`);
	}

	override dispose(): void {
		if (this._store.isDisposed) {
			return;
		}
		this._writeWindow('dispose');
		this._write({
			phase: 'lifecycle', status: 'stopped', windowIntervalMs: WINDOW_INTERVAL_MS, loopResolutionMs: LOOP_RESOLUTION_MS,
			unfinishedTaskCount: this._tasks.size, unfinishedObservationCount: this._host.runningObservationCount,
		});
		super.dispose();
		this._tasks.clear();
		this._chats.clear();
	}
}
