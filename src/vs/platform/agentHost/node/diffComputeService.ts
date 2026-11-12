/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Worker } from 'worker_threads';
import { Disposable } from '../../../base/common/lifecycle.js';
import { FileAccess } from '../../../base/common/network.js';
import { ILogService } from '../../log/common/log.js';
import { DEFAULT_DIFF_TIMEOUT_MS, IDiffComputeService, type IDetailedDiffResult, type IDiffCountResult, type IDiffHunksResult, type ISurvivalDiffResult } from '../common/diffComputeService.js';

type DiffResult = IDiffCountResult | IDetailedDiffResult | IDiffHunksResult | ISurvivalDiffResult;

/**
 * Node.js implementation of {@link IDiffComputeService} that runs
 * {@link DefaultLinesDiffComputer} in a worker thread to avoid blocking
 * the main thread.
 */
export class NodeWorkerDiffComputeService extends Disposable implements IDiffComputeService {

	declare readonly _serviceBrand: undefined;

	private _worker: Worker | undefined;
	private _workerFailures = 0;
	private _nextId = 1;
	private readonly _pending = new Map<number, { resolve: (value: DiffResult) => void; reject: (err: Error) => void }>();

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	async computeSurvivalDiff(original: string, modified: string, timeoutMs: number = DEFAULT_DIFF_TIMEOUT_MS): Promise<ISurvivalDiffResult> {
		return this._callWorker('computeSurvivalDiff', original, modified, timeoutMs);
	}

	async computeDiffCounts(original: string, modified: string, timeoutMs: number = DEFAULT_DIFF_TIMEOUT_MS): Promise<IDiffCountResult> {
		return this._callWorker('computeDiffCounts', original, modified, timeoutMs);
	}

	async computeDetailedDiff(original: string, modified: string, timeoutMs: number = DEFAULT_DIFF_TIMEOUT_MS): Promise<IDetailedDiffResult> {
		return this._callWorker('computeDetailedDiff', original, modified, timeoutMs);
	}

	async computeDiffHunks(original: string, modified: string, timeoutMs: number = DEFAULT_DIFF_TIMEOUT_MS): Promise<IDiffHunksResult> {
		return this._callWorker('computeDiffHunks', original, modified, timeoutMs);
	}

	private async _callWorker<T extends DiffResult>(functionName: string, ...args: readonly (string | number)[]): Promise<T> {
		if (this._store.isDisposed) {
			throw new Error('DiffComputeService disposed');
		}
		const worker = this._ensureWorker();
		const id = this._nextId++;
		return new Promise<T>((resolve, reject) => {
			this._pending.set(id, { resolve: value => resolve(value as T), reject });
			try {
				worker.postMessage({ id, fn: functionName, args });
			} catch (err) {
				this._pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	private _ensureWorker(): Worker {
		if (this._workerFailures >= 3) {
			throw new Error('Diff compute worker failed too many times');
		}
		if (!this._worker) {
			const workerPath = FileAccess.asFileUri('vs/platform/agentHost/node/diffWorkerMain.js').fsPath;
			const w = new Worker(workerPath, { name: 'Diff compute worker' });
			w.on('message', (msg: { id: number; res?: DiffResult; err?: { message: string; stack?: string } }) => {
				const handler = this._pending.get(msg.id);
				if (!handler) {
					return;
				}
				this._pending.delete(msg.id);
				if (msg.err) {
					const error = new Error(msg.err.message);
					if (msg.err.stack) {
						error.stack = msg.err.stack;
					}
					handler.reject(error);
				} else {
					handler.resolve(msg.res!);
				}
			});
			w.on('error', err => {
				this._logService.error('[DiffComputeService] Worker error', err);
				for (const [, handler] of this._pending) {
					handler.reject(err);
				}
				this._pending.clear();
				this._worker = undefined;
				this._workerFailures++;
			});
			w.on('exit', code => {
				if (this._worker !== w) {
					return;
				}
				const error = new Error(`Diff compute worker exited unexpectedly (${code})`);
				this._logService.error('[DiffComputeService]', error);
				for (const handler of this._pending.values()) {
					handler.reject(error);
				}
				this._pending.clear();
				this._worker = undefined;
				this._workerFailures++;
			});
			this._worker = w;
		}
		return this._worker;
	}

	override dispose(): void {
		if (this._worker) {
			this._worker.terminate();
			this._worker = undefined;
		}
		for (const [, handler] of this._pending) {
			handler.reject(new Error('DiffComputeService disposed'));
		}
		this._pending.clear();
		super.dispose();
	}
}
