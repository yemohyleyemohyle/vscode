/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { retry } from '../../../../base/common/async.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ByteSize } from '../../../files/common/files.js';
import { ILogger, LogLevel } from '../../common/log.js';
import { LoggerService } from '../../node/loggerService.js';

suite('Native logger retention', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let logsHome: string;
	let loggerService: LoggerService;
	const megabyteMessage = 'x'.repeat(ByteSize.MB);

	setup(async () => {
		logsHome = await fs.mkdtemp(join(tmpdir(), 'vscode-log-retention-'));
		loggerService = store.add(new LoggerService(LogLevel.Info, URI.file(logsHome)));
	});

	teardown(async () => {
		loggerService.dispose();
		await fs.rm(logsHome, { recursive: true, force: true });
	});

	async function waitForSize(file: string, expectedSize: number): Promise<void> {
		await retry(async () => {
			assert.strictEqual((await fs.stat(join(logsHome, file))).size, expectedSize);
		}, 10, 1000);
	}

	function writeMegabytes(logger: ILogger, count: number): void {
		for (let i = 0; i < count; i++) {
			logger.info(megabyteMessage);
		}
		logger.flush();
	}

	async function fileSizes(): Promise<{ name: string; size: number }[]> {
		const names = (await fs.readdir(logsHome)).sort();
		return Promise.all(names.map(async name => ({ name, size: (await fs.stat(join(logsHome, name))).size })));
	}

	test('keeps the default rotating limit at five MiB', async () => {
		const logger = loggerService.createLogger('default', { donotUseFormatters: true });
		writeMegabytes(logger, 5);
		await waitForSize('default.log', 5 * ByteSize.MB);
		assert.deepStrictEqual(await fileSizes(), [{ name: 'default.log', size: 5 * ByteSize.MB }]);

		writeMegabytes(logger, 1);
		await waitForSize('default.log', ByteSize.MB);
		assert.deepStrictEqual(await fileSizes(), [
			{ name: 'default.1.log', size: 5 * ByteSize.MB },
			{ name: 'default.log', size: ByteSize.MB },
		]);
	}).timeout(30000);

	test('honors a 100 MiB override through logger creation', async () => {
		const logger = loggerService.createLogger('experiment', { donotUseFormatters: true, maxFileSize: 100 * ByteSize.MB });
		writeMegabytes(logger, 100);
		await waitForSize('experiment.log', 100 * ByteSize.MB);
		assert.deepStrictEqual(await fileSizes(), [{ name: 'experiment.log', size: 100 * ByteSize.MB }]);

		writeMegabytes(logger, 1);
		await waitForSize('experiment.log', ByteSize.MB);
		assert.deepStrictEqual(await fileSizes(), [
			{ name: 'experiment.1.log', size: 100 * ByteSize.MB },
			{ name: 'experiment.log', size: ByteSize.MB },
		]);
	}).timeout(30000);

	test('keeps six backups with a size override', async () => {
		const logger = loggerService.createLogger('bounded', { donotUseFormatters: true, maxFileSize: 2048 });
		for (let i = 0; i < 16; i++) {
			logger.info(String(i).padStart(4, '0') + 'x'.repeat(1020));
		}
		logger.flush();
		await waitForSize('bounded.log', 2048);
		assert.deepStrictEqual(
			await Promise.all((await fs.readdir(logsHome)).sort().map(async name => ({
				name,
				firstRecord: (await fs.readFile(join(logsHome, name), 'utf8')).slice(0, 4),
			}))),
			[
				{ name: 'bounded.1.log', firstRecord: '0012' },
				{ name: 'bounded.2.log', firstRecord: '0010' },
				{ name: 'bounded.3.log', firstRecord: '0008' },
				{ name: 'bounded.4.log', firstRecord: '0006' },
				{ name: 'bounded.5.log', firstRecord: '0004' },
				{ name: 'bounded.6.log', firstRecord: '0002' },
				{ name: 'bounded.log', firstRecord: '0014' },
			],
		);
	}).timeout(30000);

	test('rejects invalid size overrides before creating a native logger', () => {
		for (const maxFileSize of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
			assert.throws(() => loggerService.createLogger('invalid', { maxFileSize }), RangeError);
		}
	});
});
