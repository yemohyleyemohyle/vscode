/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IRequestDiffLineChange {
	readonly path: string;
	readonly lineNumber: number;
	readonly text: string;
}

export interface IRequestDiffFile {
	readonly beforePath?: string;
	readonly afterPath?: string;
	readonly minus: readonly IRequestDiffLineChange[];
	readonly plus: readonly IRequestDiffLineChange[];
}

export interface IRequestRepositoryDiff {
	readonly from: string;
	readonly to: string;
	readonly files: readonly IRequestDiffFile[];
	readonly errors: readonly string[];
}

export interface IRequestDiffSurvivalMetric {
	readonly survivingAdditions: number;
	readonly survivingDeletions: number;
	readonly totalAdditions: number;
	readonly totalDeletions: number;
	readonly totalSurviving: number;
	readonly totalEdits: number;
	readonly ratio: number | null;
}

interface IMatch {
	readonly first: number;
	readonly second: number;
	readonly length: number;
}

export function computeRequestDiffFile(beforePath: string | undefined, afterPath: string | undefined, before: string, after: string): IRequestDiffFile {
	const beforeLines = splitLines(before);
	const afterLines = splitLines(after);
	const minus: IRequestDiffLineChange[] = [];
	const plus: IRequestDiffLineChange[] = [];

	let beforeIndex = 0;
	let afterIndex = 0;
	for (const match of getMatchingBlocks(beforeLines, afterLines)) {
		if (beforeIndex < match.first) {
			for (let index = beforeIndex; index < match.first; index++) {
				minus.push({
					path: beforePath ?? afterPath ?? '',
					lineNumber: index + 1,
					text: beforeLines[index],
				});
			}
		}
		if (afterIndex < match.second) {
			for (let index = afterIndex; index < match.second; index++) {
				plus.push({
					path: afterPath ?? beforePath ?? '',
					lineNumber: index + 1,
					text: afterLines[index],
				});
			}
		}
		beforeIndex = match.first + match.length;
		afterIndex = match.second + match.length;
	}

	return { beforePath, afterPath, minus, plus };
}

export function computeRequestDiffSurvivalMetric(
	originalRequest: IRequestRepositoryDiff,
	baselineToLatest: IRequestRepositoryDiff,
	requestResultToLatest: IRequestRepositoryDiff,
): IRequestDiffSurvivalMetric {
	const originalAdditions = originalRequest.files.flatMap(file => file.plus);
	const originalDeletions = originalRequest.files.flatMap(file => file.minus);
	const laterDeletions = requestResultToLatest.files.flatMap(file => file.minus);
	const baselineDeletions = baselineToLatest.files.flatMap(file => file.minus);
	const survivingAdditions = subtractCounts(countChanges(originalAdditions), countChanges(laterDeletions));
	const survivingDeletions = intersectCounts(countChanges(originalDeletions), countChanges(baselineDeletions));
	const totalAdditions = originalAdditions.length;
	const totalDeletions = originalDeletions.length;
	const totalSurviving = survivingAdditions + survivingDeletions;
	const totalEdits = totalAdditions + totalDeletions;

	return {
		survivingAdditions,
		survivingDeletions,
		totalAdditions,
		totalDeletions,
		totalSurviving,
		totalEdits,
		ratio: totalEdits === 0 ? null : totalSurviving / totalEdits,
	};
}

function splitLines(value: string): string[] {
	if (value.length === 0) {
		return [];
	}
	const lines = value.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
	if (/(\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029])$/.test(value)) {
		lines.pop();
	}
	return lines;
}

function getMatchingBlocks(first: readonly string[], second: readonly string[]): readonly IMatch[] {
	const secondIndices = new Map<string, number[]>();
	for (let index = 0; index < second.length; index++) {
		let indices = secondIndices.get(second[index]);
		if (!indices) {
			indices = [];
			secondIndices.set(second[index], indices);
		}
		indices.push(index);
	}

	const pending: [firstStart: number, firstEnd: number, secondStart: number, secondEnd: number][] = [[0, first.length, 0, second.length]];
	const matches: IMatch[] = [];
	while (pending.length > 0) {
		const [firstStart, firstEnd, secondStart, secondEnd] = pending.pop()!;
		const match = findLongestMatch(first, secondIndices, firstStart, firstEnd, secondStart, secondEnd);
		if (match.length === 0) {
			continue;
		}
		matches.push(match);
		if (firstStart < match.first && secondStart < match.second) {
			pending.push([firstStart, match.first, secondStart, match.second]);
		}
		const firstAfter = match.first + match.length;
		const secondAfter = match.second + match.length;
		if (firstAfter < firstEnd && secondAfter < secondEnd) {
			pending.push([firstAfter, firstEnd, secondAfter, secondEnd]);
		}
	}

	matches.sort((left, right) => left.first - right.first || left.second - right.second);
	const collapsed: IMatch[] = [];
	for (const match of matches) {
		const previous = collapsed.at(-1);
		if (previous && previous.first + previous.length === match.first && previous.second + previous.length === match.second) {
			collapsed[collapsed.length - 1] = { first: previous.first, second: previous.second, length: previous.length + match.length };
		} else {
			collapsed.push(match);
		}
	}
	collapsed.push({ first: first.length, second: second.length, length: 0 });
	return collapsed;
}

function findLongestMatch(
	first: readonly string[],
	secondIndices: ReadonlyMap<string, readonly number[]>,
	firstStart: number,
	firstEnd: number,
	secondStart: number,
	secondEnd: number,
): IMatch {
	let bestFirst = firstStart;
	let bestSecond = secondStart;
	let bestLength = 0;
	let previousLengths = new Map<number, number>();

	for (let firstIndex = firstStart; firstIndex < firstEnd; firstIndex++) {
		const currentLengths = new Map<number, number>();
		for (const secondIndex of secondIndices.get(first[firstIndex]) ?? []) {
			if (secondIndex < secondStart) {
				continue;
			}
			if (secondIndex >= secondEnd) {
				break;
			}
			const length = (previousLengths.get(secondIndex - 1) ?? 0) + 1;
			currentLengths.set(secondIndex, length);
			if (length > bestLength) {
				bestFirst = firstIndex - length + 1;
				bestSecond = secondIndex - length + 1;
				bestLength = length;
			}
		}
		previousLengths = currentLengths;
	}

	return { first: bestFirst, second: bestSecond, length: bestLength };
}

function countChanges(changes: readonly IRequestDiffLineChange[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const change of changes) {
		const key = JSON.stringify([change.path, change.lineNumber, change.text]);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

function subtractCounts(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): number {
	let result = 0;
	for (const [key, count] of left) {
		result += Math.max(0, count - (right.get(key) ?? 0));
	}
	return result;
}

function intersectCounts(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): number {
	let result = 0;
	for (const [key, count] of left) {
		result += Math.min(count, right.get(key) ?? 0);
	}
	return result;
}
