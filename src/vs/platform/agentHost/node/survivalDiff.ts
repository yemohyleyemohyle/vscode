/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DefaultLinesDiffComputer } from '../../../editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import type { ISurvivalDiffChange, ISurvivalDiffResult } from '../common/diffComputeService.js';

/** Computes exact UTF-16 changes using hybrid line alignment and character refinement. */
export function computeSurvivalDiff(original: string, modified: string, timeoutMs: number): ISurvivalDiffResult {
	try {
		if (original === modified) {
			return { status: 'completed', changes: [] };
		} else {
			const originalStarts = lineStarts(original);
			const modifiedStarts = lineStarts(modified);
			const result = new DefaultLinesDiffComputer().computeDiffWithRawChanges(original.split(/\r\n|\r|\n/), modified.split(/\r\n|\r|\n/), {
				ignoreTrimWhitespace: false, computeMoves: false, maxComputationTimeMs: timeoutMs,
			});
			return result.diff.hitTimeout
				? { status: 'timedOut', error: 'Hybrid diff timed out' }
				: {
					status: 'completed', changes: exactHybridChanges(original, modified, result.rawChanges.map(mapping => ({
						originalStart: offsetAt(originalStarts, mapping.originalRange.startLineNumber, mapping.originalRange.startColumn),
						originalEnd: offsetAt(originalStarts, mapping.originalRange.endLineNumber, mapping.originalRange.endColumn),
						modifiedStart: offsetAt(modifiedStarts, mapping.modifiedRange.startLineNumber, mapping.modifiedRange.startColumn),
						modifiedEnd: offsetAt(modifiedStarts, mapping.modifiedRange.endLineNumber, mapping.modifiedRange.endColumn),
					})))
				};
		}
	} catch (error) {
		return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
	}
}

function lineStarts(text: string): number[] {
	const starts = [0];
	const newline = /\r\n|\r|\n/g;
	let match: RegExpExecArray | null;
	while ((match = newline.exec(text))) {
		starts.push(match.index + match[0].length);
	}
	return starts;
}

function offsetAt(starts: readonly number[], line: number, column: number): number {
	if (line < 1 || line > starts.length || column < 1) {
		throw new Error('Hybrid diff returned an invalid position');
	}
	return starts[line - 1] + column - 1;
}

function newlineLength(text: string, offset: number, end: number): number {
	return offset >= end ? 0 : text[offset] === '\r' ? (offset + 1 < end && text[offset + 1] === '\n' ? 2 : 1) : text[offset] === '\n' ? 1 : 0;
}

/** Restores newline-only edits omitted by the line-oriented engine without a whole-file character fallback. */
function exactHybridChanges(original: string, modified: string, ranges: readonly {
	readonly originalStart: number; readonly originalEnd: number; readonly modifiedStart: number; readonly modifiedEnd: number;
}[]): ISurvivalDiffChange[] {
	const changes: ISurvivalDiffChange[] = [];
	let before = 0;
	let after = 0;
	for (const range of [...ranges, { originalStart: original.length, originalEnd: original.length, modifiedStart: modified.length, modifiedEnd: modified.length }]) {
		if (range.originalStart < before || range.modifiedStart < after || range.originalEnd < range.originalStart || range.modifiedEnd < range.modifiedStart
			|| range.originalEnd > original.length || range.modifiedEnd > modified.length) {
			throw new Error('Hybrid diff returned invalid or overlapping ranges');
		}
		while (before < range.originalStart || after < range.modifiedStart) {
			const originalLength = newlineLength(original, before, range.originalStart);
			const modifiedLength = newlineLength(modified, after, range.modifiedStart);
			if (originalLength && modifiedLength) {
				let prefix = 0;
				let suffix = 0;
				while (prefix < Math.min(originalLength, modifiedLength) && original[before + prefix] === modified[after + prefix]) {
					prefix++;
				}
				while (suffix < Math.min(originalLength, modifiedLength) - prefix
					&& original[before + originalLength - suffix - 1] === modified[after + modifiedLength - suffix - 1]) {
					suffix++;
				}
				if (prefix + suffix !== originalLength || prefix + suffix !== modifiedLength) {
					changes.push({
						originalStart: before + prefix, originalLength: originalLength - prefix - suffix,
						modifiedStart: after + prefix, modifiedLength: modifiedLength - prefix - suffix
					});
				}
				before += originalLength;
				after += modifiedLength;
				continue;
			}
			if (before < range.originalStart && after < range.modifiedStart && original[before] === modified[after]) {
				before++;
				after++;
				continue;
			}
			throw new Error('Hybrid diff left unmatched non-newline text');
		}
		if (range.originalEnd > range.originalStart || range.modifiedEnd > range.modifiedStart) {
			changes.push({
				originalStart: range.originalStart, originalLength: range.originalEnd - range.originalStart,
				modifiedStart: range.modifiedStart, modifiedLength: range.modifiedEnd - range.modifiedStart
			});
		}
		before = range.originalEnd;
		after = range.modifiedEnd;
	}
	return changes;
}
