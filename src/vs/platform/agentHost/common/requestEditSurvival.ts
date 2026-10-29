/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const requestEditSurvivalModes = ['10minFocusWindow', '20minFocusWindow', 'longterm'] as const;
export type RequestEditSurvivalMode = typeof requestEditSurvivalModes[number];
export type RequestEditSurvivalStatus = 'complete' | 'unavailable' | 'incomplete' | 'error';
export type RequestEditSurvivalReason = 'noActiveTracker' | 'collectionDisabled' | 'trackerDisposed' | 'correlationPending' | 'collectionError' | 'transportError';

export interface IRequestEditSurvivalBoundary {
	readonly sessionId: string;
	readonly chatId: string;
	readonly observationRequestId: string;
	readonly observationBoundary: 'requestStart' | 'requestEnd';
	readonly observationTimestamp: string;
}

export interface IRequestFocusWindowSurvivalSnapshot extends IRequestEditSurvivalBoundary {
	readonly schemaVersion: 1;
	readonly recordKind: 'requestFocusWindowSurvivalSnapshot';
	readonly mode: RequestEditSurvivalMode;
	readonly targetFocusTimeMs: number | null;
	readonly unit: 'utf16CodeUnit';
	readonly documentScope: 'existingEligibleRendererTrackers';
	readonly attributionScope: 'allSourcesInRendererTracker';
	readonly capturedTimestamp: string;
	readonly documentUri: string | null;
	readonly trackerInstanceId: string | null;
	readonly windowStartTimestamp: string | null;
	readonly elapsedFocusTimeMs: number | null;
	readonly elapsedWallTimeMs: number | null;
	readonly complete: boolean;
	readonly status: RequestEditSurvivalStatus;
	readonly reason?: RequestEditSurvivalReason;
	readonly errors: readonly string[];
	readonly sources: readonly {
		readonly sourceKey: string;
		readonly modelId: string | null;
		readonly modifiedCount: number;
		readonly deltaModifiedCount: number;
		readonly sourceSessionId?: string;
		readonly sourceAgentSessionId?: string;
		readonly sourceChatId?: string;
		readonly sourceRequestId?: string;
	}[];
}

export function unavailableRequestEditSurvivalSnapshots(boundary: IRequestEditSurvivalBoundary, reason: RequestEditSurvivalReason, errors: readonly string[] = []): IRequestFocusWindowSurvivalSnapshot[] {
	return requestEditSurvivalModes.map(mode => ({
		...boundary, schemaVersion: 1, recordKind: 'requestFocusWindowSurvivalSnapshot', mode,
		capturedTimestamp: new Date().toISOString(), targetFocusTimeMs: mode === 'longterm' ? null : mode === '10minFocusWindow' ? 600_000 : 1_200_000,
		unit: 'utf16CodeUnit', documentScope: 'existingEligibleRendererTrackers', attributionScope: 'allSourcesInRendererTracker',
		documentUri: null, trackerInstanceId: null, windowStartTimestamp: null, elapsedFocusTimeMs: null, elapsedWallTimeMs: null,
		complete: false, status: reason === 'transportError' || reason === 'collectionError' ? 'error' : 'unavailable', reason, errors, sources: [],
	}));
}
