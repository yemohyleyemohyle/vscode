/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { materializeRequestCharacterDiffFile, computeRequestCharacterDiffSurvivalMetric, type IRequestCharacterRepositoryDiff } from '../../node/chatContributions/requestDiffSurvival/requestCharacterDiffSurvival.js';
import { computeSurvivalDiff } from '../../node/survivalDiff.js';

suite('Agent Host Request Character Diff Survival', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('counts net additions, deletions, replacements, and partial survival', () => {
		const prefix = '0123456789abcdefg';
		const cases = [
			{ states: ['a', 'aXYZ', 'aXYZ'], expected: [3, 0, 3, 0, 1] },
			{ states: ['a', 'aXYZ', 'a'], expected: [0, 0, 3, 0, 0] },
			{ states: [prefix, `${prefix}XYZ`, `${prefix}X`], expected: [1, 0, 3, 0, 1 / 3] },
			{ states: ['abc', 'ac', 'ac'], expected: [0, 1, 0, 1, 1] },
			{ states: ['abc', 'ac', 'abc'], expected: [0, 0, 0, 1, 0] },
			{ states: ['value = 1', 'value = 2', 'value = 3'], expected: [0, 1, 1, 1, 0.5] },
			{ states: ['a', 'a', 'b'], expected: [0, 0, 0, 0, null] },
			{ states: ['', '中文', '中'], expected: [1, 0, 2, 0, 0.5] },
			{ states: ['中文', '', ''], expected: [0, 2, 0, 2, 1] },
		] as const;
		assert.deepStrictEqual(cases.map(({ states: [baseline, result, latest] }) => {
			const metric = computeRequestCharacterDiffSurvivalMetric(diff(baseline, result), diff(baseline, latest), diff(result, latest));
			return [metric.survivingAdditions, metric.survivingDeletions, metric.totalAdditions, metric.totalDeletions, metric.ratio];
		}), cases.map(test => [...test.expected]));
	});

	test('keeps additions in result coordinates when later insertions shift offsets', () => {
		const metric = computeRequestCharacterDiffSurvivalMetric(diff('abc', 'abcXYZ'), diff('abc', '0123456789abcXYZ'), diff('abcXYZ', '0123456789abcXYZ'));
		assert.deepStrictEqual(metric, { survivingAdditions: 3, survivingDeletions: 0, totalAdditions: 3, totalDeletions: 0, totalSurviving: 3, totalEdits: 3, ratio: 1 });
	});

	test('preserves UTF-16 offsets, whitespace, and line endings exactly', () => {
		const text = '中文\u{20000}\u{1f600}e\u0301 \t\r\n';
		assert.deepStrictEqual(computeRequestCharacterDiffFile(undefined, 'file', '', text), {
			beforePath: undefined, afterPath: 'file', minus: [],
			plus: [{ path: 'file', offset: 0, length: 12, text }],
		});
		assert.deepStrictEqual(computeRequestCharacterDiffFile('file', 'file', '\r\n', '\n').minus, [{ path: 'file', offset: 0, length: 1, text: '\r' }]);
	});

	test('uses shared-snapshot paths across Git-paired renames', () => {
		const original = { files: [computeRequestCharacterDiffFile('old', 'result', 'abc', 'abcXYZ')], errors: [] };
		const later = { files: [computeRequestCharacterDiffFile('result', 'latest', 'abcXYZ', 'abcX')], errors: [] };
		const baseline = { files: [computeRequestCharacterDiffFile('old', 'latest', 'abc', 'abcX')], errors: [] };
		assert.deepStrictEqual({
			metric: computeRequestCharacterDiffSurvivalMetric(original, baseline, later),
			pureRename: computeRequestCharacterDiffFile('old', 'new', 'abc', 'abc'),
		}, {
			metric: { survivingAdditions: 1, survivingDeletions: 0, totalAdditions: 3, totalDeletions: 0, totalSurviving: 1, totalEdits: 3, ratio: 1 / 3 },
			pureRename: { beforePath: 'old', afterPath: 'new', minus: [], plus: [] },
		});
	});

	test('keeps repeated characters and files distinct', () => {
		const original = { files: [computeRequestCharacterDiffFile('repo1#file', 'repo1#file', 'aa', 'aaa')], errors: [] };
		const unrelated = { files: [computeRequestCharacterDiffFile('repo2#file', 'repo2#file', 'aaa', 'aa')], errors: [] };
		const deleted = { files: [computeRequestCharacterDiffFile('repo1#file', undefined, 'aaa', '')], errors: [] };
		assert.deepStrictEqual([
			computeRequestCharacterDiffSurvivalMetric(original, original, unrelated).survivingAdditions,
			computeRequestCharacterDiffSurvivalMetric(original, original, deleted).survivingAdditions,
		], [1, 0]);
	});
});

function diff(before: string, after: string): IRequestCharacterRepositoryDiff {
	return { files: [computeRequestCharacterDiffFile('file', 'file', before, after)], errors: [] };
}

function computeRequestCharacterDiffFile(beforePath: string | undefined, afterPath: string | undefined, before: string, after: string) {
	const result = computeSurvivalDiff(before, after, 5000);
	if (result.status !== 'completed') {
		throw new Error(result.error);
	}
	return materializeRequestCharacterDiffFile(beforePath, afterPath, before, after, result.changes);
}
