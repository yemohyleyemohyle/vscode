/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { computeRequestCharacterDiffFile } from '../../node/chatContributions/requestDiffSurvival/requestCharacterDiffSurvival.js';
import { RequestDiffSurvivalCostObservation, type IRequestDiffSurvivalCostClock } from '../../node/chatContributions/requestDiffSurvival/requestDiffSurvivalCost.js';

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

	function fixture() {
		const log = new CostLog();
		let elapsed = 0;
		let user = 0;
		let system = 0;
		const clock: IRequestDiffSurvivalCostClock = {
			now: () => elapsed,
			cpuUsage: previous => ({ user: user - (previous?.user ?? 0), system: system - (previous?.system ?? 0) }),
		};
		const advance = (ms: number, cpuUser: number, cpuSystem: number) => {
			elapsed += ms;
			user += cpuUser;
			system += cpuSystem;
		};
		return { log, clock, advance, cost: new RequestDiffSurvivalCostObservation(log, identity, clock) };
	}

	test('records per-file timing and sums the same base request/index at comparison and observation scope', () => {
		const f = fixture();
		const file = f.cost.createFile('originalRequest', 0, 0);
		file.fileInputBytes = 2;
		file.beforeUtf16Length = 0;
		file.afterUtf16Length = 2;
		f.cost.beginComparison('originalRequest');
		const first = f.cost.measureFile(file, () => {
			f.advance(7, 4000, 1000);
			return computeRequestCharacterDiffFile(undefined, 'file', '', 'xy');
		});
		f.cost.finishComparison('originalRequest', 'completed');
		f.cost.beginComparison('baselineToLatest');
		f.cost.measureFile(f.cost.createFile('baselineToLatest', 1, 0), () => {
			f.advance(3, 2000, 500);
			return first;
		});
		f.cost.finishComparison('baselineToLatest', 'completed');
		f.cost.finishComparison('requestResultToLatest', 'reused');
		f.cost.finishObservation('completed');
		assert.deepStrictEqual(f.log.events.map(event => ({
			phase: event.phase, comparison: event.comparisonKind, base: event.originatingRequestId, index: event.observationIndex,
			status: event.status, elapsed: event.elapsedMs, cpu: [event.cpuUserMs, event.cpuSystemMs, event.cpuTotalMs],
		})), [
			{ phase: 'file', comparison: 'originalRequest', base: 'base', index: 3, status: 'completed', elapsed: 7, cpu: [4, 1, 5] },
			{ phase: 'comparison', comparison: 'originalRequest', base: 'base', index: 3, status: 'completed', elapsed: 7, cpu: [4, 1, 5] },
			{ phase: 'file', comparison: 'baselineToLatest', base: 'base', index: 3, status: 'completed', elapsed: 3, cpu: [2, 0.5, 2.5] },
			{ phase: 'comparison', comparison: 'baselineToLatest', base: 'base', index: 3, status: 'completed', elapsed: 3, cpu: [2, 0.5, 2.5] },
			{ phase: 'comparison', comparison: 'requestResultToLatest', base: 'base', index: 3, status: 'reused', elapsed: null, cpu: [null, null, null] },
			{ phase: 'observation', comparison: undefined, base: 'base', index: 3, status: 'completed', elapsed: 10, cpu: [6, 1.5, 7.5] },
		]);
	});

	test('records a failed call without replacing its exception or fabricating output', () => {
		const f = fixture();
		const failure = new Error('diff failed');
		assert.throws(() => f.cost.measureFile(f.cost.createFile('originalRequest', 0, 0), () => {
			f.advance(2, 1000, 0);
			throw failure;
		}), error => error === failure);
		const event = f.log.events[0];
		assert.deepStrictEqual({
			status: event.status, elapsed: event.elapsedMs, cpu: event.cpuTotalMs, added: event.addedCharacters, started: event.startedFileCount,
		}, { status: 'failed', elapsed: 2, cpu: 1, added: null, started: 1 });
	});

	test('marks unsupported CPU explicitly while preserving elapsed timing', () => {
		const log = new CostLog();
		let now = 0;
		const cost = new RequestDiffSurvivalCostObservation(log, identity, { now: () => now++ });
		cost.measureFile(cost.createFile('originalRequest', 0, 0), () => computeRequestCharacterDiffFile('file', 'file', 'x', 'y'));
		const event = log.events[0];
		assert.deepStrictEqual({
			elapsed: event.elapsedMs, cpuStatus: event.cpuMeasurementStatus, cpu: [event.cpuUserMs, event.cpuSystemMs, event.cpuTotalMs],
		}, { elapsed: 1, cpuStatus: 'unsupported', cpu: [null, null, null] });
	});

	for (const failAt of [1, 2]) {
		test(`CPU read ${failAt} failure is logged and does not change a successful diff`, () => {
			const log = new CostLog();
			let reads = 0;
			const cost = new RequestDiffSurvivalCostObservation(log, identity, {
				now: () => 0,
				cpuUsage: () => {
					if (++reads === failAt) {
						throw new Error('CPU unavailable');
					}
					return { user: 0, system: 0 };
				},
			});
			const expected = computeRequestCharacterDiffFile('file', 'file', 'x', 'y');
			const result = cost.measureFile(cost.createFile('originalRequest', 0, 0), () => expected);
			assert.deepStrictEqual({
				sameResult: result === expected, status: log.events[0].status, cpu: log.events[0].cpuTotalMs,
				cpuStatus: log.events[0].cpuMeasurementStatus, warnings: log.warnings,
			}, {
				sameResult: true, status: 'completed', cpu: null, cpuStatus: 'failed',
				warnings: ['[RequestDiffSurvivalCost] Thread CPU measurement failed'],
			});
		});
	}

	test('not-started work and unattempted comparisons have unavailable timing, not zero CPU', () => {
		const f = fixture();
		f.cost.fileNotStarted(f.cost.createFile('originalRequest', 0, 0), 'budgetRejected');
		f.cost.finishComparison('originalRequest', 'budgetRejected');
		f.cost.finishObservation('budgetRejected');
		assert.deepStrictEqual(f.log.events.map(event => ({
			phase: event.phase, status: event.status, started: event.startedFileCount, elapsed: event.elapsedMs, cpu: event.cpuTotalMs,
		})), [
			{ phase: 'file', status: 'budgetRejected', started: 0, elapsed: null, cpu: null },
			{ phase: 'comparison', status: 'budgetRejected', started: 0, elapsed: null, cpu: null },
			{ phase: 'comparison', status: 'notStarted', started: 0, elapsed: null, cpu: null },
			{ phase: 'comparison', status: 'notStarted', started: 0, elapsed: null, cpu: null },
			{ phase: 'observation', status: 'budgetRejected', started: 0, elapsed: null, cpu: null },
		]);
	});

	test('defers size-event logging inside budget callbacks until both ending readings', () => {
		const order: string[] = [];
		const log = new class extends CostLog {
			override info(message: string): void {
				order.push(message.startsWith(RequestDiffSurvivalCostObservation.sizeLogPrefix) ? 'log:size' : 'log:compute');
				super.info(message);
			}
		}();
		const cost = new RequestDiffSurvivalCostObservation(log, identity, {
			now: () => { order.push('time'); return 0; },
			cpuUsage: () => { order.push('cpu'); return { user: 0, system: 0 }; },
		});
		cost.measureFile(cost.createFile('originalRequest', 0, 0), () => {
			order.push('compute');
			cost.size({ phase: 'release', status: 'completed', reason: 'budgetRejected', trackerEstimatedRetainedBytes: 0, hostEstimatedRetainedBytes: 0 });
			return computeRequestCharacterDiffFile('file', 'file', '', '');
		});
		assert.deepStrictEqual(order, ['cpu', 'time', 'compute', 'time', 'cpu', 'log:size', 'log:compute']);
	});

	test('cost logging failure is explicit and cannot replace a diff exception', () => {
		const log = new class extends CostLog {
			override info(): void { throw new Error('logger failed'); }
		}();
		const cost = new RequestDiffSurvivalCostObservation(log, identity, { now: () => 0 });
		const failure = new Error('diff failed');
		assert.throws(() => cost.measureFile(cost.createFile('originalRequest', 0, 0), () => { throw failure; }), error => error === failure);
		assert.deepStrictEqual(log.warnings, ['[RequestDiffSurvivalCost] Cost event logging failed']);
	});
});
