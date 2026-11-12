/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isCancellationError } from '../../../../../base/common/errors.js';
import type { ILogService } from '../../../../log/common/log.js';
import type { URI as ProtocolURI } from '../../../common/state/sessionState.js';
import type { ISurvivalDiffChange, ISurvivalDiffResult } from '../../../common/diffComputeService.js';
import type { IRequestCharacterDiffFile } from './requestCharacterDiffSurvival.js';
import { RequestDiffSurvivalBudgetError, RequestDiffSurvivalInputBudget, requestDiffSurvivalLimits } from './requestDiffSurvivalLimits.js';

export type RequestDiffSurvivalComparison = 'originalRequest' | 'baselineToLatest' | 'requestResultToLatest';
export type RequestDiffSurvivalCostOutcome = 'completed' | 'failed' | 'budgetRejected' | 'cancelled';
export class RequestDiffSurvivalComputationError extends Error { }

interface ICostIdentity {
	readonly sessionId: ProtocolURI;
	readonly chatId: ProtocolURI;
	readonly originatingRequestId: string;
	readonly observationRequestId: string;
	readonly observationIndex: number;
}

export interface IRequestDiffSurvivalCostClock {
	readonly now: () => number;
}

export interface IRequestDiffSurvivalFileCost {
	readonly comparisonKind: RequestDiffSurvivalComparison;
	readonly repositoryIndex: number;
	readonly fileIndex: number;
	fileInputBytes: number | null;
	beforeUtf16Length: number | null;
	afterUtf16Length: number | null;
	computationStarted: boolean;
}

export interface IRequestDiffSurvivalSizeDetails {
	readonly phase: 'inputCheck' | 'fileConstruction' | 'admission' | 'rollback' | 'budgetRejection' | 'release' | 'observation';
	readonly status: RequestDiffSurvivalCostOutcome | 'started';
	readonly comparisonKind?: RequestDiffSurvivalComparison;
	readonly repositoryIndex?: number;
	readonly fileIndex?: number;
	readonly fileInputBytes?: number | null;
	readonly trackerEstimatedRetainedBytes: number;
	readonly hostEstimatedRetainedBytes: number;
	readonly retainedBytesDelta?: number;
	readonly proposedObservationInputBytes?: number | null;
	readonly proposedHostEstimatedRetainedBytes?: number | null;
	readonly reason?: 'horizon' | 'budgetRejected' | 'failed' | 'cancelled' | 'stateDisposed' | 'idleExpired' | 'maximumAgeExceeded';
}

interface IComputeTotals {
	fileCount: number;
	startedFileCount: number;
	completedFileCount: number;
	failedFileCount: number;
	elapsedMs: number;
	cpuUserMs: number;
	cpuSystemMs: number;
	serviceCallElapsedMs: number;
}

const comparisons: readonly RequestDiffSurvivalComparison[] = ['originalRequest', 'baselineToLatest', 'requestResultToLatest'];
const defaultClock: IRequestDiffSurvivalCostClock = {
	now: () => performance.now(),
};

function createTotals(): IComputeTotals {
	return { fileCount: 0, startedFileCount: 0, completedFileCount: 0, failedFileCount: 0, elapsedMs: 0, cpuUserMs: 0, cpuSystemMs: 0, serviceCallElapsedMs: 0 };
}

export function getRequestDiffSurvivalCostOutcome(error: unknown): RequestDiffSurvivalCostOutcome {
	return error instanceof RequestDiffSurvivalBudgetError ? 'budgetRejected' : isCancellationError(error) ? 'cancelled' : 'failed';
}

/** Owns only small accounting/timing metadata for one survival observation, never diff results. */
export class RequestDiffSurvivalCostObservation {
	static readonly computeLogPrefix = '[RequestCharacterDiffComputeObservation] ';
	static readonly sizeLogPrefix = '[RequestCharacterDiffSizeObservation] ';

	readonly inputBudget = new RequestDiffSurvivalInputBudget();
	private readonly _comparisonTotals = new Map<RequestDiffSurvivalComparison, IComputeTotals>();
	private readonly _totals = createTotals();
	private _cpuStatus: 'available' | 'unsupported' | 'failed' = 'available';
	private _elapsedAvailable = true;

	constructor(
		private readonly _logService: ILogService,
		private readonly _identity: ICostIdentity,
		private readonly _clock: IRequestDiffSurvivalCostClock = defaultClock,
	) { }

	beginComparison(comparison: RequestDiffSurvivalComparison): void {
		this._comparisonTotals.set(comparison, createTotals());
	}

	createFile(comparisonKind: RequestDiffSurvivalComparison, repositoryIndex: number, fileIndex: number): IRequestDiffSurvivalFileCost {
		return { comparisonKind, repositoryIndex, fileIndex, fileInputBytes: null, beforeUtf16Length: null, afterUtf16Length: null, computationStarted: false };
	}

	async measureWorkerFile(
		file: IRequestDiffSurvivalFileCost,
		compute: () => Promise<ISurvivalDiffResult>,
		materialize: (changes: readonly ISurvivalDiffChange[]) => IRequestCharacterDiffFile,
	): Promise<IRequestCharacterDiffFile> {
		const started = this._clock.now();
		file.computationStarted = true;
		let response: ISurvivalDiffResult | undefined;
		let result: IRequestCharacterDiffFile | undefined;
		let serviceCallElapsedMs = 0;
		let outcome: RequestDiffSurvivalCostOutcome = 'failed';
		try {
			try {
				response = await compute();
			} finally {
				serviceCallElapsedMs = this._clock.now() - started;
			}
			if (response.status !== 'completed') {
				throw new RequestDiffSurvivalComputationError(response.error);
			}
			result = materialize(response.changes);
			outcome = 'completed';
			return result;
		} catch (error) {
			outcome = getRequestDiffSurvivalCostOutcome(error);
			if (!response && outcome !== 'cancelled') {
				throw new RequestDiffSurvivalComputationError(error instanceof Error ? error.message : String(error));
			}
			throw error;
		} finally {
			const measurement = response?.measurement;
			if (!measurement) {
				this._cpuStatus = 'failed';
				this._elapsedAvailable = false;
				this._logService.warn('[RequestDiffSurvivalCost] Worker measurement unavailable');
			} else {
				if (measurement.cpuMeasurementStatus !== 'available') {
					this._cpuStatus = measurement.cpuMeasurementStatus;
				}
				if (measurement.cpuMeasurementError) {
					this._logService.warn('[RequestDiffSurvivalCost] Worker thread CPU measurement failed', measurement.cpuMeasurementError);
				}
			}
			const totals: IComputeTotals = {
				fileCount: 1, startedFileCount: 1, completedFileCount: result ? 1 : 0, failedFileCount: result ? 0 : 1,
				elapsedMs: measurement?.elapsedMs ?? 0, cpuUserMs: measurement?.cpuUserMs ?? 0, cpuSystemMs: measurement?.cpuSystemMs ?? 0,
				serviceCallElapsedMs,
			};
			this._addFileTotals(file.comparisonKind, totals);
			this._computeEvent('file', outcome, totals, {
				...file, computationOutcome: response?.status ?? 'unknown',
				addedCharacters: result?.plus.reduce((sum, change) => sum + change.length, 0) ?? null,
				removedCharacters: result?.minus.reduce((sum, change) => sum + change.length, 0) ?? null,
				changeRangeCount: result ? result.plus.length + result.minus.length : null,
			});
		}
	}

	fileNotStarted(file: IRequestDiffSurvivalFileCost, outcome: RequestDiffSurvivalCostOutcome): void {
		const totals = { ...createTotals(), fileCount: 1 };
		this._addFileTotals(file.comparisonKind, totals);
		this._computeEvent('file', outcome, totals, { ...file, addedCharacters: null, removedCharacters: null, changeRangeCount: null });
	}

	finishComparison(comparisonKind: RequestDiffSurvivalComparison, outcome: RequestDiffSurvivalCostOutcome | 'reused' | 'empty'): void {
		const totals = this._comparisonTotals.get(comparisonKind) ?? createTotals();
		this._comparisonTotals.set(comparisonKind, totals);
		this._computeEvent('comparison', outcome, totals, { comparisonKind });
	}

	finishObservation(outcome: RequestDiffSurvivalCostOutcome): void {
		for (const comparisonKind of comparisons) {
			if (!this._comparisonTotals.has(comparisonKind)) {
				this._computeEvent('comparison', 'notStarted', createTotals(), { comparisonKind, reason: outcome });
			}
		}
		this._computeEvent('observation', outcome, this._totals);
	}

	size(details: IRequestDiffSurvivalSizeDetails): void {
		const event = {
			...this._identity, schemaVersion: 1, recordKind: 'requestCharacterDiffSizeObservation',
			timestamp: new Date().toISOString(), unit: 'accountedBytes',
			observationInputBytes: this.inputBudget.inputBytes, limits: requestDiffSurvivalLimits,
			...details,
		};
		this._write(RequestDiffSurvivalCostObservation.sizeLogPrefix, event);
	}

	private _addFileTotals(comparison: RequestDiffSurvivalComparison, file: IComputeTotals): void {
		let totals = this._comparisonTotals.get(comparison);
		if (!totals) {
			totals = createTotals();
			this._comparisonTotals.set(comparison, totals);
		}
		for (const target of [totals, this._totals]) {
			target.fileCount += file.fileCount;
			target.startedFileCount += file.startedFileCount;
			target.completedFileCount += file.completedFileCount;
			target.failedFileCount += file.failedFileCount;
			target.elapsedMs += file.elapsedMs;
			target.cpuUserMs += file.cpuUserMs;
			target.cpuSystemMs += file.cpuSystemMs;
			target.serviceCallElapsedMs += file.serviceCallElapsedMs;
		}
	}

	private _computeEvent(
		phase: 'file' | 'comparison' | 'observation',
		status: RequestDiffSurvivalCostOutcome | 'reused' | 'empty' | 'notStarted',
		totals: IComputeTotals,
		details: { readonly comparisonKind?: RequestDiffSurvivalComparison; readonly reason?: RequestDiffSurvivalCostOutcome } & Partial<IRequestDiffSurvivalFileCost> & {
			readonly addedCharacters?: number | null; readonly removedCharacters?: number | null; readonly changeRangeCount?: number | null;
			readonly computationOutcome?: string;
		} = {},
	): void {
		const measured = totals.startedFileCount > 0;
		const cpuAvailable = measured && this._cpuStatus === 'available';
		this._write(RequestDiffSurvivalCostObservation.computeLogPrefix, {
			...this._identity, schemaVersion: 2, recordKind: 'requestCharacterDiffComputeObservation',
			engine: 'worker-hybrid', algorithm: 'hybrid',
			executionLocation: 'worker',
			measurementScope: 'diffAndOffsetMapping',
			timestamp: new Date().toISOString(), phase, status, timeUnit: 'milliseconds', characterUnit: 'utf16CodeUnit',
			fileCount: totals.fileCount, startedFileCount: totals.startedFileCount,
			completedFileCount: totals.completedFileCount, failedFileCount: totals.failedFileCount,
			elapsedMs: measured && this._elapsedAvailable ? totals.elapsedMs : null,
			serviceCallElapsedMs: measured ? totals.serviceCallElapsedMs : null,
			cpuMeasurementStatus: measured ? this._cpuStatus : 'notStarted',
			cpuUserMs: cpuAvailable ? totals.cpuUserMs : null,
			cpuSystemMs: cpuAvailable ? totals.cpuSystemMs : null,
			cpuTotalMs: cpuAvailable ? totals.cpuUserMs + totals.cpuSystemMs : null,
			...details,
		});
	}

	private _write(prefix: string, record: object): void {
		try {
			this._logService.info(`${prefix}${JSON.stringify(record)}`);
		} catch (error) {
			this._logService.warn('[RequestDiffSurvivalCost] Cost event logging failed', error);
		}
	}
}
