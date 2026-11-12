/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../base/common/async.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { RequestDiffSurvivalDiagnostics, type IRequestDiffSurvivalDiagnosticsRuntime, type RequestDiffSurvivalDiagnosticRecord } from '../../node/chatContributions/requestDiffSurvival/requestDiffSurvivalDiagnostics.js';

class DiagnosticLogService extends NullLogService {
	readonly records: RequestDiffSurvivalDiagnosticRecord[] = [];

	override info(message: string): void {
		assert.ok(message.startsWith(RequestDiffSurvivalDiagnostics.logPrefix));
		this.records.push(JSON.parse(message.slice(RequestDiffSurvivalDiagnostics.logPrefix.length)));
	}
}

class DiagnosticRuntime implements IRequestDiffSurvivalDiagnosticsRuntime {
	time = 0;
	sample = { sampleCount: 0, p95Ms: null as number | null, maxMs: null as number | null };
	window: (() => void) | undefined;
	monitorDisposed = false;
	timerDisposed = false;
	resets = 0;

	now(): number {
		return this.time;
	}

	createLoopMonitor(): ReturnType<IRequestDiffSurvivalDiagnosticsRuntime['createLoopMonitor']> {
		return {
			read: () => ({ ...this.sample }),
			reset: () => {
				this.resets++;
				this.sample = { sampleCount: 0, p95Ms: null, maxMs: null };
			},
			dispose: () => { this.monitorDisposed = true; },
		};
	}

	scheduleWindow(callback: () => void) {
		this.window = callback;
		return toDisposable(() => {
			this.timerDisposed = true;
			this.window = undefined;
		});
	}
}

suite('Agent Host Request Diff Survival Diagnostics', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const identity = { sessionId: 'session', chatId: 'chat', requestId: 'request', taskKind: 'turnEnd' as const };
	const observation = {
		sessionId: 'session', chatId: 'chat', originatingRequestId: 'origin',
		observationRequestId: 'request', observationIndex: 2, observationBoundary: 'requestEnd' as const,
	};

	test('disabled-survival baseline has independent, parseable elapsed windows with null empty samples', () => {
		const log = new DiagnosticLogService();
		const runtime = new DiagnosticRuntime();
		disposables.add(new RequestDiffSurvivalDiagnostics('disabled', log, runtime));
		runtime.time = 1000;
		runtime.window?.();
		runtime.sample = { sampleCount: 90, p95Ms: 12, maxMs: 45 };
		runtime.time = 2250;
		runtime.window?.();
		assert.deepStrictEqual(log.records.filter(record => record.phase === 'window').map(record => ({
			engine: record.engine, timeUnit: record.timeUnit, timingKind: record.timingKind,
			windowElapsedMs: record.windowElapsedMs, eventLoop: record.eventLoop, host: record.host, chats: record.chats,
		})), [
			{
				engine: 'disabled', timeUnit: 'ms', timingKind: 'elapsed', windowElapsedMs: 1000,
				eventLoop: { sampleCount: 0, p95Ms: null, maxMs: null, status: 'noSamples', resolutionMs: 10 },
				host: { queuedTaskCount: 0, runningTaskCount: 0, runningObservationCount: 0, peakPendingTaskCount: 0 }, chats: [],
			},
			{
				engine: 'disabled', timeUnit: 'ms', timingKind: 'elapsed', windowElapsedMs: 1250,
				eventLoop: { sampleCount: 90, p95Ms: 12, maxMs: 45, status: 'available', resolutionMs: 10 },
				host: { queuedTaskCount: 0, runningTaskCount: 0, runningObservationCount: 0, peakPendingTaskCount: 0 }, chats: [],
			},
		]);
	});

	test('separates task queue wait, processing, and observation delay behind preceding work', () => {
		const log = new DiagnosticLogService();
		const runtime = new DiagnosticRuntime();
		const collector = disposables.add(new RequestDiffSurvivalDiagnostics('worker-hybrid', log, runtime));
		collector.noteEligibleTurnEnd();
		const first = collector.enqueueTask(identity);
		runtime.time = 10;
		first.start();
		runtime.time = 20;
		const second = collector.enqueueTask({ ...identity, requestId: 'next' });
		const other = collector.enqueueTask({ ...identity, chatId: 'other' });
		runtime.time = 25;
		other.start();
		other.finish('failed');
		runtime.time = 30;
		const finish = collector.startObservation(observation, first.id);
		runtime.time = 50;
		finish('budgetRejected');
		first.finish('completed');
		runtime.time = 60;
		second.start();
		const finishNext = collector.startObservation({ ...observation, observationRequestId: 'next' }, second.id);
		runtime.time = 100;
		finishNext('completed');
		second.finish('completed');
		assert.deepStrictEqual({
			tasks: log.records.filter(record => record.phase === 'task').filter(record => record.status !== 'queued' && record.status !== 'started').map(record => ({
				taskId: record.taskId, status: record.status, queueWaitMs: record.queueWaitMs,
				processingElapsedMs: record.processingElapsedMs, totalElapsedMs: record.totalElapsedMs, host: record.host,
			})),
			observations: log.records.filter(record => record.phase === 'observation').map(record => ({
				taskId: record.taskId, status: record.status, processingElapsedMs: record.processingElapsedMs,
				sinceTaskEnqueuedMs: record.sinceTaskEnqueuedMs,
			})),
			drains: log.records.filter(record => record.phase === 'drain').map(record => ({
				busyPeriodElapsedMs: record.busyPeriodElapsedMs, sinceLastEnqueueMs: record.sinceLastEnqueueMs,
				sinceLastEligibleTurnEndMs: record.sinceLastEligibleTurnEndMs,
			})),
		}, {
			tasks: [
				{ taskId: 3, status: 'failed', queueWaitMs: 5, processingElapsedMs: 0, totalElapsedMs: 5, host: { queuedTaskCount: 1, runningTaskCount: 1, runningObservationCount: 0, peakPendingTaskCount: 3 } },
				{ taskId: 1, status: 'completed', queueWaitMs: 10, processingElapsedMs: 40, totalElapsedMs: 50, host: { queuedTaskCount: 1, runningTaskCount: 0, runningObservationCount: 0, peakPendingTaskCount: 3 } },
				{ taskId: 2, status: 'completed', queueWaitMs: 40, processingElapsedMs: 40, totalElapsedMs: 80, host: { queuedTaskCount: 0, runningTaskCount: 0, runningObservationCount: 0, peakPendingTaskCount: 3 } },
			],
			observations: [
				{ taskId: 1, status: 'budgetRejected', processingElapsedMs: 20, sinceTaskEnqueuedMs: 30 },
				{ taskId: 2, status: 'completed', processingElapsedMs: 40, sinceTaskEnqueuedMs: 40 },
			],
			drains: [{ busyPeriodElapsedMs: 100, sinceLastEnqueueMs: 80, sinceLastEligibleTurnEndMs: 100 }],
		});
	});

	test('reports unfinished work on shutdown, releases timers, and ignores late completions', () => {
		const log = new DiagnosticLogService();
		const runtime = new DiagnosticRuntime();
		const collector = disposables.add(new RequestDiffSurvivalDiagnostics('worker-hybrid', log, runtime));
		const task = collector.enqueueTask(identity);
		task.start();
		collector.enqueueTask({ ...identity, requestId: 'queued' });
		const finish = collector.startObservation(observation, task.id);
		runtime.time = 50;
		collector.dispose();
		const count = log.records.length;
		task.finish('cancelled');
		finish('cancelled');
		collector.dispose();
		assert.deepStrictEqual({
			stopped: log.records.filter(record => record.phase === 'lifecycle').filter(record => record.status === 'stopped').map(record => ({
				unfinishedTaskCount: record.unfinishedTaskCount, unfinishedObservationCount: record.unfinishedObservationCount,
			})),
			disposed: [runtime.monitorDisposed, runtime.timerDisposed],
			lateRecordCount: log.records.length - count,
			drains: log.records.filter(record => record.phase === 'drain').length,
		}, {
			stopped: [{ unfinishedTaskCount: 2, unfinishedObservationCount: 1 }],
			disposed: [true, true], lateRecordCount: 0, drains: 0,
		});
	});

	test('cancelled queued tasks and observations without a task settle once and remove idle chats', () => {
		const log = new DiagnosticLogService();
		const runtime = new DiagnosticRuntime();
		const collector = disposables.add(new RequestDiffSurvivalDiagnostics('worker-hybrid', log, runtime));
		const task = collector.enqueueTask(identity);
		task.finish('cancelled');
		task.finish('cancelled');
		const finish = collector.startObservation({ ...observation, observationBoundary: 'expiry' });
		runtime.time = 10;
		finish('cancelled');
		finish('cancelled');
		runtime.window?.();
		assert.deepStrictEqual({
			observations: log.records.filter(record => record.phase === 'observation').map(record => ({
				status: record.status, processingElapsedMs: record.processingElapsedMs, taskId: record.taskId,
				sinceTaskEnqueuedMs: record.sinceTaskEnqueuedMs,
			})),
			tasks: log.records.filter(record => record.phase === 'task').filter(record => record.status === 'cancelled').map(record => ({
				queueWaitMs: record.queueWaitMs, processingElapsedMs: record.processingElapsedMs,
			})),
			chats: log.records.filter(record => record.phase === 'window').map(record => record.chats),
		}, {
			observations: [{ status: 'cancelled', processingElapsedMs: 10, taskId: null, sinceTaskEnqueuedMs: null }],
			tasks: [{ queueWaitMs: null, processingElapsedMs: null }], chats: [[]],
		});
	});

	test('records have a stable run identity and strictly increasing sequence across all phases', () => {
		const log = new DiagnosticLogService();
		const collector = disposables.add(new RequestDiffSurvivalDiagnostics('worker-hybrid', log, new DiagnosticRuntime()));
		const task = collector.enqueueTask(identity);
		task.start();
		task.finish('completed');
		collector.dispose();
		assert.deepStrictEqual({
			runCount: new Set(log.records.map(record => record.diagnosticsRunId)).size,
			kinds: [...new Set(log.records.map(record => record.recordKind))],
			versions: [...new Set(log.records.map(record => record.schemaVersion))],
			sequences: log.records.map(record => record.sequence),
			timestampsValid: log.records.every(record => Number.isFinite(Date.parse(record.timestamp))),
		}, {
			runCount: 1, kinds: ['requestDiffSurvivalDiagnostics'], versions: [1],
			sequences: [1, 2, 3, 4, 5, 6, 7], timestampsValid: true,
		});
	});

	test('real event-loop monitor reports milliseconds and stops on disposal', async () => {
		const log = new DiagnosticLogService();
		const collector = disposables.add(new RequestDiffSurvivalDiagnostics('disabled', log));
		await timeout(60);
		collector.dispose();
		const window = log.records.find(record => record.phase === 'window');
		assert.ok(window?.phase === 'window' && window.eventLoop.sampleCount > 0
			&& window.eventLoop.p95Ms !== null && window.eventLoop.p95Ms >= 1
			&& window.eventLoop.maxMs !== null && window.eventLoop.maxMs >= window.eventLoop.p95Ms
			&& window.eventLoop.maxMs <= window.windowElapsedMs + window.eventLoop.resolutionMs);
	});
});
