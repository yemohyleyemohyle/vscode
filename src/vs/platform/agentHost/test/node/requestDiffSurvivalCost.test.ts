/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import type { ISurvivalDiffMeasurement } from '../../common/diffComputeService.js';
import { materializeRequestCharacterDiffFile } from '../../node/chatContributions/requestDiffSurvival/requestCharacterDiffSurvival.js';
import { RequestDiffSurvivalCostObservation } from '../../node/chatContributions/requestDiffSurvival/requestDiffSurvivalCost.js';

interface ICostEvent {
	readonly recordKind: string;
	readonly phase: string;
	readonly status: string;
	readonly originatingRequestId: string;
	readonly observationIndex: number;
	readonly elapsedMs: number | null;
	readonly cpuMeasurementStatus: string;
	readonly cpuUserMs: number | null;
	readonly cpuSystemMs: number | null;
	readonly cpuTotalMs: number | null;
	readonly startedFileCount: number;
	readonly addedCharacters: number | null;
	readonly comparisonKind: string;
	readonly schemaVersion: number;
	readonly engine: string;
	readonly measurementScope: string;
	readonly serviceCallElapsedMs: number | null;
}

class CostLog extends NullLogService {
	readonly events: ICostEvent[] = [];
	readonly warnings: string[] = [];
	override info(message: string): void {
		this.events.push(JSON.parse(message.slice(message.indexOf('] ') + 2)));
	}
	override warn(message: string): void {
		this.warnings.push(message);
	}
}

suite('Agent Host Request Diff Survival Cost', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const identity = { sessionId: 'session', chatId: 'chat', originatingRequestId: 'base', observationRequestId: 'later', observationIndex: 3 };
	const changes = [{ originalStart: 0, originalLength: 0, modifiedStart: 0, modifiedLength: 1 }];
	const materialize = () => materializeRequestCharacterDiffFile('file', 'file', '', 'x', changes);

	test('aggregates worker CPU at file, comparison and observation scope, not service-call latency', async () => {
		const log = new CostLog();
		let now = 0;
		const cost = new RequestDiffSurvivalCostObservation(log, identity, { now: () => now });
		for (const [comparison, elapsedMs, cpuUserMs, cpuSystemMs] of [
			['originalRequest', 7, 4, 1], ['baselineToLatest', 3, 2, 0.5],
		] as const) {
			cost.beginComparison(comparison);
			await cost.measureWorkerFile(cost.createFile(comparison, 0, 0), async () => {
				now += 100;
				return { status: 'completed', changes, measurement: { elapsedMs, cpuMeasurementStatus: 'available', cpuUserMs, cpuSystemMs } };
			}, materialize);
			cost.finishComparison(comparison, 'completed');
		}
		cost.finishComparison('requestResultToLatest', 'reused');
		cost.finishObservation('completed');
		assert.deepStrictEqual(log.events.map(event => ({
			phase: event.phase, comparison: event.comparisonKind, base: event.originatingRequestId, index: event.observationIndex,
			status: event.status, elapsed: event.elapsedMs, serviceElapsed: event.serviceCallElapsedMs, cpu: event.cpuTotalMs,
			schema: event.schemaVersion, engine: event.engine, scope: event.measurementScope,
		})), [
			{ phase: 'file', comparison: 'originalRequest', base: 'base', index: 3, status: 'completed', elapsed: 7, serviceElapsed: 100, cpu: 5, schema: 2, engine: 'worker-hybrid', scope: 'diffAndOffsetMapping' },
			{ phase: 'comparison', comparison: 'originalRequest', base: 'base', index: 3, status: 'completed', elapsed: 7, serviceElapsed: 100, cpu: 5, schema: 2, engine: 'worker-hybrid', scope: 'diffAndOffsetMapping' },
			{ phase: 'file', comparison: 'baselineToLatest', base: 'base', index: 3, status: 'completed', elapsed: 3, serviceElapsed: 100, cpu: 2.5, schema: 2, engine: 'worker-hybrid', scope: 'diffAndOffsetMapping' },
			{ phase: 'comparison', comparison: 'baselineToLatest', base: 'base', index: 3, status: 'completed', elapsed: 3, serviceElapsed: 100, cpu: 2.5, schema: 2, engine: 'worker-hybrid', scope: 'diffAndOffsetMapping' },
			{ phase: 'comparison', comparison: 'requestResultToLatest', base: 'base', index: 3, status: 'reused', elapsed: null, serviceElapsed: null, cpu: null, schema: 2, engine: 'worker-hybrid', scope: 'diffAndOffsetMapping' },
			{ phase: 'observation', comparison: undefined, base: 'base', index: 3, status: 'completed', elapsed: 10, serviceElapsed: 200, cpu: 7.5, schema: 2, engine: 'worker-hybrid', scope: 'diffAndOffsetMapping' },
		]);
	});

	test('worker timeout reports consumed CPU and transport failure is unknown, not zero', async () => {
		const log = new CostLog();
		const cost = new RequestDiffSurvivalCostObservation(log, identity, { now: () => 0 });
		await assert.rejects(cost.measureWorkerFile(cost.createFile('originalRequest', 0, 0), async () => ({
			status: 'timedOut', error: 'timed out',
			measurement: { elapsedMs: 5, cpuMeasurementStatus: 'available', cpuUserMs: 3, cpuSystemMs: 1 },
		}), () => { throw new Error('Must not materialize'); }), /timed out/);
		await assert.rejects(cost.measureWorkerFile(cost.createFile('originalRequest', 0, 1),
			async () => { throw new Error('worker exited'); }, () => { throw new Error('Must not materialize'); }), /worker exited/);
		cost.finishObservation('failed');
		assert.deepStrictEqual(log.events.filter(event => event.phase !== 'comparison').map(event => ({
			phase: event.phase, status: event.status, elapsed: event.elapsedMs, cpuStatus: event.cpuMeasurementStatus, cpu: event.cpuTotalMs,
		})), [
			{ phase: 'file', status: 'failed', elapsed: 5, cpuStatus: 'available', cpu: 4 },
			{ phase: 'file', status: 'failed', elapsed: null, cpuStatus: 'failed', cpu: null },
			{ phase: 'observation', status: 'failed', elapsed: null, cpuStatus: 'failed', cpu: null },
		]);
	});

	for (const status of ['unsupported', 'failed'] as const) {
		test(`preserves successful output when worker CPU measurement is ${status}`, async () => {
			const log = new CostLog();
			const cost = new RequestDiffSurvivalCostObservation(log, identity, { now: () => 0 });
			const measurement: ISurvivalDiffMeasurement = {
				elapsedMs: 1, cpuMeasurementStatus: status, cpuUserMs: null, cpuSystemMs: null,
				...(status === 'failed' ? { cpuMeasurementError: 'CPU unavailable' } : {}),
			};
			const result = await cost.measureWorkerFile(cost.createFile('originalRequest', 0, 0),
				async () => ({ status: 'completed', changes, measurement }), materialize);
			assert.deepStrictEqual({
				result, status: log.events[0].status, elapsed: log.events[0].elapsedMs,
				cpu: log.events[0].cpuTotalMs, cpuStatus: log.events[0].cpuMeasurementStatus, warnings: log.warnings,
			}, {
				result: materialize(), status: 'completed', elapsed: 1, cpu: null, cpuStatus: status,
				warnings: status === 'failed' ? ['[RequestDiffSurvivalCost] Worker thread CPU measurement failed'] : [],
			});
		});
	}

	test('not-started work and unattempted comparisons have unavailable timing, not zero CPU', () => {
		const log = new CostLog();
		const cost = new RequestDiffSurvivalCostObservation(log, identity);
		cost.fileNotStarted(cost.createFile('originalRequest', 0, 0), 'budgetRejected');
		cost.finishComparison('originalRequest', 'budgetRejected');
		cost.finishObservation('budgetRejected');
		assert.deepStrictEqual(log.events.map(event => ({
			phase: event.phase, status: event.status, started: event.startedFileCount, elapsed: event.elapsedMs, cpu: event.cpuTotalMs,
		})), [
			{ phase: 'file', status: 'budgetRejected', started: 0, elapsed: null, cpu: null },
			{ phase: 'comparison', status: 'budgetRejected', started: 0, elapsed: null, cpu: null },
			{ phase: 'comparison', status: 'notStarted', started: 0, elapsed: null, cpu: null },
			{ phase: 'comparison', status: 'notStarted', started: 0, elapsed: null, cpu: null },
			{ phase: 'observation', status: 'budgetRejected', started: 0, elapsed: null, cpu: null },
		]);
	});

	test('materialization failure preserves its exception and the completed worker measurement', async () => {
		const log = new CostLog();
		const cost = new RequestDiffSurvivalCostObservation(log, identity, { now: () => 0 });
		const failure = new Error('construction failed');
		await assert.rejects(cost.measureWorkerFile(cost.createFile('originalRequest', 0, 0), async () => ({
			status: 'completed', changes,
			measurement: { elapsedMs: 2, cpuMeasurementStatus: 'available', cpuUserMs: 1, cpuSystemMs: 0 },
		}), () => { throw failure; }), error => error === failure);
		assert.deepStrictEqual({
			status: log.events[0].status, elapsed: log.events[0].elapsedMs, cpu: log.events[0].cpuTotalMs, added: log.events[0].addedCharacters,
		}, { status: 'failed', elapsed: 2, cpu: 1, added: null });
	});

	test('cost logging failure is explicit and cannot replace a diff exception', async () => {
		const log = new class extends CostLog {
			override info(): void { throw new Error('logger failed'); }
		}();
		const cost = new RequestDiffSurvivalCostObservation(log, identity, { now: () => 0 });
		await assert.rejects(cost.measureWorkerFile(cost.createFile('originalRequest', 0, 0), async () => ({
			status: 'failed', error: 'diff failed',
			measurement: { elapsedMs: 0, cpuMeasurementStatus: 'available', cpuUserMs: 0, cpuSystemMs: 0 },
		}), materialize), /diff failed/);
		assert.deepStrictEqual(log.warnings, ['[RequestDiffSurvivalCost] Cost event logging failed']);
	});
});
