/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import type { ISurvivalDiffResult } from '../../common/diffComputeService.js';
import { NodeWorkerDiffComputeService } from '../../node/diffComputeService.js';
import { computeSurvivalDiff } from '../../node/survivalDiff.js';
import { computeRequestCharacterDiffSurvivalMetric, materializeRequestCharacterDiffFile } from '../../node/chatContributions/requestDiffSurvival/requestCharacterDiffSurvival.js';

suite('Agent Host Hybrid Survival Diff', () => {
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

	test('reconstructs exact text including newline-only and Unicode edits', () => {
		assert.deepStrictEqual(samples.map(([before, after]) => reconstruct(before, after, computeSurvivalDiff(before, after, 5000))), samples.map(([, after]) => after));
	});

	test('preserves A/B coordinates for addition and deletion survival', () => {
		const a = 'header\r\nold\r\nfooter\r\n';
		const b = 'header\r\nnew\r\nfooter\r\n';
		const c = 'header\r\nneX\r\nfooter\r\n';
		const diff = (before: string, after: string) => {
			const result = computeSurvivalDiff(before, after, 5000);
			if (result.status !== 'completed') {
				throw new Error(JSON.stringify(result));
			}
			return { files: [materializeRequestCharacterDiffFile('file', 'file', before, after, result.changes)], errors: [] };
		};
		assert.deepStrictEqual(computeRequestCharacterDiffSurvivalMetric(diff(a, b), diff(a, c), diff(b, c)), {
			survivingAdditions: 2, survivingDeletions: 3, totalAdditions: 3, totalDeletions: 3, totalSurviving: 5, totalEdits: 6, ratio: 5 / 6,
		});
	});

	workerTest('runs through the real shared worker without diagnostic measurements', async () => {
		const service = disposables.add(new NodeWorkerDiffComputeService(new NullLogService()));
		const results = await Promise.all(samples.map(([before, after]) => service.computeSurvivalDiff(before, after)));
		assert.deepStrictEqual({
			texts: results.map((result, index) => reconstruct(samples[index][0], samples[index][1], result)),
			resultKeys: [...new Set(results.map(result => Object.keys(result).sort().join(',')))],
		}, { texts: samples.map(([, after]) => after), resultKeys: ['changes,status'] });
	});

	test('hybrid newline-only edits retain the shared LF rather than replacing entire lines', () => {
		const result = computeSurvivalDiff('a\r\nb\r\n', 'a\nb\n', 5000);
		assert.deepStrictEqual(result.status === 'completed' ? result.changes : result, [
			{ originalStart: 1, originalLength: 1, modifiedStart: 1, modifiedLength: 0 },
			{ originalStart: 4, originalLength: 1, modifiedStart: 3, modifiedLength: 0 },
		]);
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
		assert.deepStrictEqual(cases.map(([before, after]) => reconstruct(before, after, computeSurvivalDiff(before, after, 5000))), cases.map(([, after]) => after));
	});

	workerTest('disposing the worker rejects pending work and prevents worker resurrection', async () => {
		const service = disposables.add(new NodeWorkerDiffComputeService(new NullLogService()));
		const pending = service.computeSurvivalDiff('a', 'b');
		service.dispose();
		await assert.rejects(pending, /disposed/);
		await assert.rejects(service.computeSurvivalDiff('a', 'b'), /disposed/);
	});
});
