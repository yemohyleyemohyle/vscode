/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ISurvivalDiffChange } from '../../../common/diffComputeService.js';

interface IRequestCharacterDiffSurvivalMetric {
	readonly survivingAdditions: number;
	readonly survivingDeletions: number;
	readonly totalAdditions: number;
	readonly totalDeletions: number;
	readonly totalSurviving: number;
	readonly totalEdits: number;
	readonly ratio: number | null;
}

export interface IRequestCharacterChange {
	readonly path: string;
	readonly offset: number;
	readonly length: number;
	readonly text: string;
}

export interface IRequestCharacterDiffFile {
	readonly beforePath?: string;
	readonly afterPath?: string;
	readonly minus: readonly IRequestCharacterChange[];
	readonly plus: readonly IRequestCharacterChange[];
}

export interface IRequestCharacterRepositoryDiff {
	readonly files: readonly IRequestCharacterDiffFile[];
	readonly errors: readonly string[];
}

export function materializeRequestCharacterDiffFile(
	beforePath: string | undefined, afterPath: string | undefined, before: string, after: string,
	changes: readonly ISurvivalDiffChange[],
): IRequestCharacterDiffFile {
	const minus: IRequestCharacterChange[] = [];
	const plus: IRequestCharacterChange[] = [];
	for (const change of changes) {
		if (change.originalLength > 0) {
			minus.push({ path: beforePath ?? afterPath ?? '', offset: change.originalStart, length: change.originalLength, text: before.slice(change.originalStart, change.originalStart + change.originalLength) });
		}
		if (change.modifiedLength > 0) {
			plus.push({ path: afterPath ?? beforePath ?? '', offset: change.modifiedStart, length: change.modifiedLength, text: after.slice(change.modifiedStart, change.modifiedStart + change.modifiedLength) });
		}
	}
	return { beforePath, afterPath, minus, plus };
}

export function computeRequestCharacterDiffSurvivalMetric(
	originalRequest: IRequestCharacterRepositoryDiff,
	baselineToLatest: IRequestCharacterRepositoryDiff,
	requestResultToLatest: IRequestCharacterRepositoryDiff,
): IRequestCharacterDiffSurvivalMetric {
	const additions = originalRequest.files.flatMap(file => file.plus);
	const deletions = originalRequest.files.flatMap(file => file.minus);
	const totalAdditions = additions.reduce((sum, change) => sum + change.length, 0);
	const totalDeletions = deletions.reduce((sum, change) => sum + change.length, 0);
	const survivingAdditions = totalAdditions - intersectRanges(additions, requestResultToLatest.files.flatMap(file => file.minus));
	const survivingDeletions = intersectRanges(deletions, baselineToLatest.files.flatMap(file => file.minus));
	const totalEdits = totalAdditions + totalDeletions;
	const totalSurviving = survivingAdditions + survivingDeletions;
	return { survivingAdditions, survivingDeletions, totalAdditions, totalDeletions, totalSurviving, totalEdits, ratio: totalEdits === 0 ? null : totalSurviving / totalEdits };
}

function rangesByPath(changes: readonly IRequestCharacterChange[]): Map<string, IRequestCharacterChange[]> {
	const paths = new Map<string, IRequestCharacterChange[]>();
	for (const change of changes) {
		let ranges = paths.get(change.path);
		if (!ranges) {
			ranges = [];
			paths.set(change.path, ranges);
		}
		ranges.push(change);
	}
	for (const ranges of paths.values()) {
		ranges.sort((a, b) => a.offset - b.offset);
	}
	return paths;
}

function intersectRanges(first: readonly IRequestCharacterChange[], second: readonly IRequestCharacterChange[]): number {
	const secondPaths = rangesByPath(second);
	let count = 0;
	for (const [path, firstRanges] of rangesByPath(first)) {
		const secondRanges = secondPaths.get(path) ?? [];
		let firstIndex = 0;
		let secondIndex = 0;
		while (firstIndex < firstRanges.length && secondIndex < secondRanges.length) {
			const left = firstRanges[firstIndex];
			const right = secondRanges[secondIndex];
			const leftEnd = left.offset + left.length;
			const rightEnd = right.offset + right.length;
			count += Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(left.offset, right.offset));
			if (leftEnd <= rightEnd) {
				firstIndex++;
			} else {
				secondIndex++;
			}
		}
	}
	return count;
}
