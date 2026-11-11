/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import type { ISurvivalDiffResult, SurvivalDiffAlgorithm } from '../../common/diffComputeService.js';
import { NodeWorkerDiffComputeService } from '../../node/diffComputeService.js';
import { computeSurvivalDiff } from '../../node/survivalDiff.js';
import { computeRequestCharacterDiffFile, computeRequestCharacterDiffSurvivalMetric, materializeRequestCharacterDiffFile } from '../../node/chatContributions/requestDiffSurvival/requestCharacterDiffSurvival.js';

suite('Agent Host Survival Diff Engines', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	teardown(() => sinon.restore());
	const workerTest = process.type === 'renderer' ? test.skip : test;

	const samples = [
		['', ''],
		['', 'new\r\nfile\n'],
		['removed\nfile', ''],
		['prefix old suffix\nnext\n', 'prefix new suffix\nnext\n'],
		['  spaces \t\n', '\tspaces  \n'],
		['one\r\ntwo\r\n', 'one\ntwo\n'],
		['one\ntwo\n', 'one\r\ntwo\r\n'],
		['one\r\ntwo\r\n', 'one\rtwo\r'],
		['one\rtwo\r', 'one\ntwo\n'],
		['one\r\ntwo\r\nthree\r\n', 'one\nchanged\nthree\n'],
		['one\n', 'one'],
		['a a a a', 'b b b b'],
		['repeat\nsame\nrepeat\nsame\n', 'repeat\nchanged\nrepeat\nsame\n'],
		['before \u{1f600} after\r\n', 'before \u{1f603} after\n'],
		['const value = ' + 'x'.repeat(2000), 'const value = ' + 'x'.repeat(999) + 'y' + 'x'.repeat(1000)],
	];

	function reconstruct(before: string, after: string, result: ISurvivalDiffResult): string {
		assert.strictEqual(result.status, 'completed', JSON.stringify(result));
		if (result.status !== 'completed') {
			throw new Error('Expected completed diff');
		}
		let offset = 0;
		const parts: string[] = [];
		for (const change of result.changes) {
			parts.push(before.slice(offset, change.originalStart), after.slice(change.modifiedStart, change.modifiedStart + change.modifiedLength));
			offset = change.originalStart + change.originalLength;
		}
		parts.push(before.slice(offset));
		return parts.join('');
	}

	for (const algorithm of ['character', 'hybrid'] satisfies SurvivalDiffAlgorithm[]) {
		test(`${algorithm} reconstructs exact text including newline-only and Unicode edits`, () => {
			assert.deepStrictEqual(samples.map(([before, after]) => reconstruct(before, after, computeSurvivalDiff(before, after, algorithm, 5000))), samples.map(([, after]) => after));
		});

		test(`${algorithm} preserves A/B coordinates for addition and deletion survival`, () => {
			const a = 'header\r\nold\r\nfooter\r\n';
			const b = 'header\r\nnew\r\nfooter\r\n';
			const c = 'header\r\nneX\r\nfooter\r\n';
			const diff = (before: string, after: string) => {
				const result = computeSurvivalDiff(before, after, algorithm, 5000);
				if (result.status !== 'completed') {
					throw new Error(JSON.stringify(result));
				}
				return { files: [materializeRequestCharacterDiffFile('file', 'file', before, after, result.changes)], errors: [] };
			};
			assert.deepStrictEqual(computeRequestCharacterDiffSurvivalMetric(diff(a, b), diff(a, c), diff(b, c)), {
				survivingAdditions: 2, survivingDeletions: 3, totalAdditions: 3, totalDeletions: 3, totalSurviving: 5, totalEdits: 6, ratio: 5 / 6,
			});
		});

		workerTest(`${algorithm} runs through the real shared worker and returns thread measurements`, async () => {
			const service = disposables.add(new NodeWorkerDiffComputeService(new NullLogService()));
			const results = await Promise.all(samples.map(([before, after]) => service.computeSurvivalDiff(before, after, algorithm)));
			assert.deepStrictEqual({
				texts: results.map((result, index) => reconstruct(samples[index][0], samples[index][1], result)),
				measured: results.every(result => result.measurement.elapsedMs >= 0
					&& (result.measurement.cpuMeasurementStatus === 'available'
						? result.measurement.cpuUserMs !== null && result.measurement.cpuSystemMs !== null
						: result.measurement.cpuUserMs === null && result.measurement.cpuSystemMs === null)),
			}, { texts: samples.map(([, after]) => after), measured: true });
		});
	}

	test('worker character lane matches the current whole-text character ranges', () => {
		assert.deepStrictEqual(samples.map(([before, after]) => {
			const result = computeSurvivalDiff(before, after, 'character', 0);
			if (result.status !== 'completed') {
				throw new Error(JSON.stringify(result));
			}
			return materializeRequestCharacterDiffFile('file', 'file', before, after, result.changes);
		}), samples.map(([before, after]) => computeRequestCharacterDiffFile('file', 'file', before, after)));
	});

	test('hybrid newline-only edits retain the shared LF rather than replacing entire lines', () => {
		const result = computeSurvivalDiff('a\r\nb\r\n', 'a\nb\n', 'hybrid', 5000);
		assert.deepStrictEqual(result.status === 'completed' ? result.changes : result, [
			{ originalStart: 1, originalLength: 1, modifiedStart: 1, modifiedLength: 0 },
			{ originalStart: 4, originalLength: 1, modifiedStart: 3, modifiedLength: 0 },
		]);
	});

	test('character timeout returns measured incomplete work, not approximate changes', () => {
		let now = 0;
		const result = computeSurvivalDiff('a'.repeat(200), 'b'.repeat(200), 'character', 1, { now: () => now++ });
		assert.deepStrictEqual({
			status: result.status, hasChanges: Object.hasOwn(result, 'changes'), cpu: result.measurement.cpuUserMs,
			cpuStatus: result.measurement.cpuMeasurementStatus,
		}, { status: 'timedOut', hasChanges: false, cpu: null, cpuStatus: 'unsupported' });
	});

	test('hybrid reconstructs deterministic mixed-newline edits without whole-file fallback', () => {
		let seed = 41;
		const next = (max: number) => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed % max;
		};
		const tokens = ['a', 'b', ' ', '\r\n', '\n', '\r', '\u{1f600}'];
		const cases = Array.from({ length: 200 }, () => {
			const before = Array.from({ length: 20 }, () => tokens[next(tokens.length)]).join('');
			const start = next(before.length + 1);
			const after = before.slice(0, start) + tokens[next(tokens.length)] + before.slice(Math.min(before.length, start + next(4)));
			return [before, after];
		});
		assert.deepStrictEqual(cases.map(([before, after]) => reconstruct(before, after, computeSurvivalDiff(before, after, 'hybrid', 5000))), cases.map(([, after]) => after));
	});

	test('failed thread CPU reading does not change successful output', () => {
		const result = computeSurvivalDiff('a', 'b', 'hybrid', 5000, {
			now: () => 0, cpuUsage: () => { throw new Error('cpu failed'); },
		});
		assert.deepStrictEqual({
			status: result.status, cpu: result.measurement,
		}, { status: 'completed', cpu: { elapsedMs: 0, cpuMeasurementStatus: 'failed', cpuUserMs: null, cpuSystemMs: null, cpuMeasurementError: 'cpu failed' } });
	});

	workerTest('disposing the worker rejects pending work and prevents worker resurrection', async () => {
		const service = disposables.add(new NodeWorkerDiffComputeService(new NullLogService()));
		const pending = service.computeSurvivalDiff('a', 'b', 'hybrid');
		service.dispose();
		await assert.rejects(pending, /disposed/);
		await assert.rejects(service.computeSurvivalDiff('a', 'b', 'hybrid'), /disposed/);
	});
});
