/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { readToolCallMeta, toToolCallMeta } from '../../common/meta/agentToolCallMeta.js';

suite('Agent tool request execution metadata', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('validates execution and request identity independently', () => {
		assert.deepStrictEqual([
			readToolCallMeta({
				_meta: toToolCallMeta({
					'vscode.editToolExecution': true,
					'vscode.toolRequest': { chat: 'opaque-chat', turnId: 'request' },
				})
			}),
			readToolCallMeta({ _meta: { 'vscode.editToolExecution': false } }),
			readToolCallMeta({ _meta: { 'vscode.editToolExecution': 'true', 'vscode.toolRequest': { chat: 'chat', turnId: 1 } } }),
			readToolCallMeta({ _meta: { 'vscode.toolRequest': { chat: '', turnId: 'request' } } }),
			readToolCallMeta({}),
		], [
			{ 'vscode.editToolExecution': true, 'vscode.toolRequest': { chat: 'opaque-chat', turnId: 'request' } },
			{ 'vscode.editToolExecution': false },
			{}, {}, {},
		]);
	});
});
