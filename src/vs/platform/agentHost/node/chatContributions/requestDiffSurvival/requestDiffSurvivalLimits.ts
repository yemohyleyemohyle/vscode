/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const requestDiffSurvivalLimits = {
	maximumFileInputBytes: 512 * 1024,
	maximumObservationInputBytes: 4 * 1024 * 1024,
	maximumRetainedDiffBytes: 16 * 1024 * 1024,
	maximumFollowUpCount: 10,
	idleExpiryMs: 60 * 60 * 1000,
	maximumTrackerAgeMs: 24 * 60 * 60 * 1000,
} as const;

export class RequestDiffSurvivalBudgetError extends Error {
	constructor(
		readonly fileInputBudgetExceeded: boolean,
		readonly observationInputBudgetExceeded: boolean,
		readonly retainedDiffBudgetExceeded: boolean,
		readonly diagnostics: {
			readonly fileInputBytes?: number;
			readonly observationInputBytes?: number;
			readonly proposedRetainedDiffBytes?: number;
		},
	) {
		super('Request character-diff survival budget exceeded');
	}
}

export class RequestDiffSurvivalInputBudget {
	private _inputBytes = 0;

	get inputBytes(): number {
		return this._inputBytes;
	}

	consume(fileInputBytes: number): void {
		const proposedInputBytes = this._inputBytes + fileInputBytes;
		const fileExceeded = fileInputBytes > requestDiffSurvivalLimits.maximumFileInputBytes;
		const observationExceeded = proposedInputBytes > requestDiffSurvivalLimits.maximumObservationInputBytes;
		if (fileExceeded || observationExceeded) {
			throw new RequestDiffSurvivalBudgetError(fileExceeded, observationExceeded, false, {
				fileInputBytes, observationInputBytes: proposedInputBytes,
			});
		}
		this._inputBytes = proposedInputBytes;
	}
}
