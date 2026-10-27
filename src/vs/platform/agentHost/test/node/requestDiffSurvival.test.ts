/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { computeRequestDiffFile, computeRequestDiffSurvivalMetric, type IRequestRepositoryDiff } from '../../node/chatContributions/requestDiffSurvival/requestDiffSurvival.js';

suite('Agent Host Request Diff Survival', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('matches the proposal survival examples', () => {
		const scenarios = [
			{ name: 'retained addition', states: ['a', 'a\nnew', 'a\nnew'], expected: [1, 0, 1, 0, 1] },
			{ name: 'removed addition', states: ['a', 'a\nnew', 'a'], expected: [0, 0, 1, 0, 0] },
			{ name: 'retained pure deletion', states: ['a\nb\nc', 'a\nc', 'a\nc'], expected: [0, 1, 0, 1, 1] },
			{ name: 'restored deletion', states: ['a\nb\nc', 'a\nc', 'a\nb\nc'], expected: [0, 0, 0, 1, 0] },
			{ name: 'revised replacement', states: ['value = 1', 'value = 2', 'value = 3'], expected: [0, 1, 1, 1, 0.5] },
		] as const;

		assert.deepStrictEqual(scenarios.map(scenario => {
			const [baseline, requestResult, latest] = scenario.states;
			const metric = computeRequestDiffSurvivalMetric(
				diff('s0', 's1', baseline, requestResult),
				diff('s0', 'latest', baseline, latest),
				diff('s1', 'latest', requestResult, latest),
			);
			return {
				name: scenario.name,
				actual: [metric.survivingAdditions, metric.survivingDeletions, metric.totalAdditions, metric.totalDeletions, metric.ratio],
				expected: [...scenario.expected],
			};
		}), scenarios.map(scenario => ({
			name: scenario.name,
			actual: [...scenario.expected],
			expected: [...scenario.expected],
		})));
	});

	test('keeps duplicate lines distinct by their state-relative line numbers', () => {
		const metric = computeRequestDiffSurvivalMetric(
			diff('s0', 's1', 'a\na', 'a'),
			diff('s0', 's2', 'a\na', 'a\nb'),
			diff('s1', 's2', 'a', 'a\nb'),
		);

		assert.deepStrictEqual(metric, {
			survivingAdditions: 0,
			survivingDeletions: 1,
			totalAdditions: 0,
			totalDeletions: 1,
			totalSurviving: 1,
			totalEdits: 1,
			ratio: 1,
		});
	});

	test('returns null for a request without a net edit', () => {
		const metric = computeRequestDiffSurvivalMetric(
			diff('s0', 's1', 'a', 'a'),
			diff('s0', 's2', 'a', 'b'),
			diff('s1', 's2', 'a', 'b'),
		);

		assert.strictEqual(metric.ratio, null);
	});
});

function diff(from: string, to: string, before: string, after: string): IRequestRepositoryDiff {
	return {
		from,
		to,
		files: [computeRequestDiffFile('file:///repo/file.txt', 'file:///repo/file.txt', before, after)],
		errors: [],
	};
}
