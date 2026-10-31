/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IObservableWithChange, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { OffsetRange } from '../../../../../editor/common/core/ranges/offsetRange.js';
import { AnnotatedStringEdit, StringEdit } from '../../../../../editor/common/core/edits/stringEdit.js';
import { StringText } from '../../../../../editor/common/core/text/abstractText.js';
import { EditSources, TextModelEditSource } from '../../../../../editor/common/textModelEditSource.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EditKeySourceData, EditSourceData, IDocumentWithAnnotatedEdits } from '../../browser/helpers/documentWithAnnotatedEdits.js';
import { DocumentEditSourceTracker } from '../../browser/telemetry/editTracker.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IExternalEditCorrelation, IExternalEditCorrelationResolution } from '../../browser/telemetry/agentHostEditMarkerService.js';

suite('DocumentEditSourceTracker', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('snapshots pending edits without applying or consuming them', () => {
		const document = disposables.add(new TestAnnotatedDocument(''));
		const tracker = disposables.add(new DocumentEditSourceTracker(document, undefined));
		const source = chatEditSource('kimi-k3', 'author-request');
		document.apply(StringEdit.insert(0, 'abcdef'), source);
		document.apply(StringEdit.delete(new OffsetRange(2, 4)), EditSources.reloadFromDisk());
		const initial = snapshot(tracker);
		const sampled = tracker.snapshot();
		const repeated = tracker.snapshot();
		const afterSampling = snapshot(tracker);
		tracker.applyPendingExternalEdits();
		const final = snapshot(tracker);
		assert.deepStrictEqual({
			initial, afterSampling, repeated,
			sampled: sampled.sources.map(entry => ({ key: entry.representative.toKey(1), retained: entry.modifiedCount, delta: entry.deltaModifiedCount })),
			pending: sampled.correlationPending, final,
		}, {
			initial: [{ key: source.toKey(1), delta: 6, retained: 6, requestId: 'author-request' }],
			afterSampling: initial, repeated: sampled, pending: false,
			sampled: [{ key: source.toKey(1), retained: 4, delta: 6 }, { key: 'source:reloadFromDisk', retained: 0, delta: 0 }],
			final: [
				{ key: source.toKey(1), delta: 6, retained: 4, requestId: 'author-request' },
				{ key: 'source:reloadFromDisk', delta: 0, retained: 0, requestId: undefined },
			].sort((a, b) => a.key.localeCompare(b.key)),
		});
	});

	test('snapshots resolved pending external edits without releasing correlations', () => {
		const document = disposables.add(new TestAnnotatedDocument(''));
		const correlation = new TestExternalEditCorrelation();
		const tracker = disposables.add(new DocumentEditSourceTracker(document, undefined, correlation, 'reattribute'));
		document.apply(StringEdit.insert(0, '\u4e2d\u6587\ud840\udc00\ud83d\ude00\r\n'), EditSources.reloadFromDisk());
		const pending = tracker.snapshot();
		const source = agentHostEditSource('kimi-k3', 'author-turn', 'copilotcli');
		correlation.resolve(correlation.lastObservationId!, source);
		const resolved = tracker.snapshot();
		const repeated = tracker.snapshot();
		assert.deepStrictEqual({
			pending: pending.correlationPending,
			resolved: resolved.sources.map(entry => ({ modelId: entry.representative.props.$modelId, retained: entry.modifiedCount, delta: entry.deltaModifiedCount })),
			resolutionRetained: correlation.getResolution(correlation.lastObservationId!)?.source === source,
			normalCounts: snapshot(tracker),
			repeated,
		}, {
			pending: true,
			resolved: [{ modelId: 'kimi-k3', retained: 8, delta: 8 }],
			resolutionRetained: true, normalCounts: [], repeated: resolved,
		});
	});

	test('ignores an initial external edit', () => {
		const document = disposables.add(new TestAnnotatedDocument('initial'));
		const tracker = disposables.add(new DocumentEditSourceTracker(document, undefined));

		document.apply(StringEdit.replace(OffsetRange.ofLength(7), 'external'), EditSources.reloadFromDisk());

		assert.deepStrictEqual(snapshot(tracker), []);
	});

	for (const scenario of [
		{ name: 'insertion', edit: StringEdit.insert(6, 'X'), retained: 6, inserted: 1, newRetained: 1 },
		{ name: 'replacement', edit: StringEdit.replace(new OffsetRange(1, 4), 'X'), retained: 3, inserted: 1, newRetained: 1 },
		{ name: 'deletion', edit: StringEdit.delete(new OffsetRange(2, 4)), retained: 4, inserted: 0, newRetained: 0 },
		{ name: 'complete removal', edit: StringEdit.delete(OffsetRange.ofLength(6)), retained: 0, inserted: 0, newRetained: 0 },
	]) {
		for (const lateResolution of [false, true]) {
			test(`preserves successive external insertion history: ${scenario.name}, late resolution=${lateResolution}`, () => {
				const document = disposables.add(new TestAnnotatedDocument(''));
				const correlation = new TestExternalEditCorrelation();
				const tracker = disposables.add(new DocumentEditSourceTracker(document, undefined, correlation, 'reattribute'));
				const first = agentHostEditSource('kimi-k3', 'first', 'copilotcli');
				const second = agentHostEditSource('gpt-5', 'second', 'copilotcli');
				document.apply(StringEdit.insert(0, 'abcdef'), EditSources.reloadFromDisk());
				if (!lateResolution) {
					correlation.resolve('observation-1', first);
				}
				document.apply(scenario.edit, EditSources.reloadFromDisk());
				correlation.resolve('observation-2', second);
				if (lateResolution) {
					correlation.resolve('observation-1', first);
				}
				const project = () => tracker.snapshot().sources.map(entry => ({
					request: entry.representative.props.$$requestId, inserted: entry.deltaModifiedCount, retained: entry.modifiedCount,
				}));
				const pending = project();
				const repeated = project();
				tracker.applyPendingExternalEdits();
				tracker.applyPendingExternalEdits();
				const applied = project();
				const normal = snapshot(tracker).map(entry => ({ request: entry.requestId, inserted: entry.delta, retained: entry.retained }));
				document.apply(StringEdit.insert(0, '!'), EditSources.cursor({ kind: 'type' }));
				assert.deepStrictEqual({ pending, repeated, applied, normal, afterLocal: project() }, {
					pending: [
						{ request: 'first', inserted: 6, retained: scenario.retained },
						{ request: 'second', inserted: scenario.inserted, retained: scenario.newRetained },
					],
					repeated: pending, applied: pending, normal: pending,
					afterLocal: [...pending, { request: undefined, inserted: 1, retained: 1 }],
				});
			});
		}
	}

	test('preserves overwritten pending history through suppression and invalidation', () => {
		const document = disposables.add(new TestAnnotatedDocument(''));
		const correlation = new TestExternalEditCorrelation();
		const tracker = disposables.add(new DocumentEditSourceTracker(document, undefined, correlation));
		document.apply(StringEdit.insert(0, 'abcdef'), EditSources.reloadFromDisk());
		document.apply(StringEdit.delete(OffsetRange.ofLength(6)), EditSources.reloadFromDisk());
		correlation.suppress('observation-1');
		correlation.suppress('observation-2');
		const suppressed = tracker.snapshot().sources;
		const excluded = tracker.snapshot().excludedAgentHostObservationCount;
		tracker.applyPendingExternalEdits();
		const fallback = snapshot(tracker, true);
		correlation.invalidate('observation-1');
		assert.deepStrictEqual({ suppressed, excluded, fallback, invalidated: snapshot(tracker), remainingExcluded: tracker.snapshot().excludedAgentHostObservationCount }, {
			suppressed: [],
			excluded: 2,
			fallback: [
				{ key: 'external-observation:observation-1', delta: 6, retained: 0, requestId: undefined },
				{ key: 'external-observation:observation-2', delta: 0, retained: 0, requestId: undefined },
			],
			invalidated: [{ key: 'external-observation:observation-1', delta: 6, retained: 0, requestId: undefined }],
			remainingExcluded: 1,
		});
	});

	test('preserves uncorrelated external insertion history when a local edit drains it', () => {
		const document = disposables.add(new TestAnnotatedDocument(''));
		const tracker = disposables.add(new DocumentEditSourceTracker(document, undefined));
		const user = EditSources.cursor({ kind: 'type' });
		document.apply(StringEdit.insert(0, '!'), user);
		document.apply(StringEdit.insert(1, 'abcdef'), EditSources.reloadFromDisk());
		document.apply(StringEdit.replace(new OffsetRange(2, 5), 'X'), EditSources.reloadFromDisk());
		const pending = tracker.snapshot().sources.map(entry => ({ inserted: entry.deltaModifiedCount, retained: entry.modifiedCount }));
		document.apply(StringEdit.insert(0, '?'), user);
		assert.deepStrictEqual({ pending, applied: snapshot(tracker) }, {
			pending: [{ inserted: 1, retained: 1 }, { inserted: 7, retained: 4 }],
			applied: [
				{ key: user.toKey(1), delta: 2, retained: 2, requestId: undefined },
				{ key: 'source:reloadFromDisk', delta: 7, retained: 4, requestId: undefined },
			],
		});
	});

	test('retains a matched initial external edit only for fallback', () => {
		const document = disposables.add(new TestAnnotatedDocument('initial'));
		const correlation = new TestExternalEditCorrelation();
		const tracker = disposables.add(new DocumentEditSourceTracker(document, undefined, correlation));

		document.apply(StringEdit.replace(OffsetRange.ofLength(7), 'external'), EditSources.reloadFromDisk());
		tracker.applyPendingExternalEdits();
		const beforeSuppression = snapshot(tracker, true);
		correlation.suppress(correlation.lastObservationId!);
		const fallback = snapshot(tracker, true);
		tracker.dispose();

		assert.deepStrictEqual({
			beforeSuppression,
			fallback,
			afterDisposeStandard: snapshot(tracker),
			afterDisposeFallback: snapshot(tracker, true),
		}, {
			beforeSuppression: [],
			fallback: [{
				key: 'external-observation:observation-1',
				delta: 8,
				retained: 8,
				requestId: undefined,
			}],
			afterDisposeStandard: [],
			afterDisposeFallback: [{
				key: 'external-observation:observation-1',
				delta: 8,
				retained: 8,
				requestId: undefined,
			}],
		});
	});

	test('restores external attribution when Agent Host suppression is invalidated', () => {
		const document = disposables.add(new TestAnnotatedDocument('initial'));
		const correlation = new TestExternalEditCorrelation();
		const tracker = disposables.add(new DocumentEditSourceTracker(document, undefined, correlation));

		document.apply(StringEdit.replace(OffsetRange.ofLength(7), 'external'), EditSources.reloadFromDisk());
		tracker.applyPendingExternalEdits();
		correlation.suppress(correlation.lastObservationId!);
		correlation.invalidate(correlation.lastObservationId!);

		assert.deepStrictEqual(snapshot(tracker), [{
			key: 'external-observation:observation-1',
			delta: 8,
			retained: 8,
			requestId: undefined,
		}]);
	});

	test('applies queued external edits before the next attributed edit', () => {
		const document = disposables.add(new TestAnnotatedDocument(''));
		const tracker = disposables.add(new DocumentEditSourceTracker(document, undefined));
		const ai = chatEditSource('gpt-5', 'request-1');
		const user = EditSources.cursor({ kind: 'type' });

		document.apply(StringEdit.insert(0, 'abcdef'), ai);
		document.apply(StringEdit.delete(new OffsetRange(2, 4)), EditSources.reloadFromDisk());

		assert.deepStrictEqual(snapshot(tracker), [{
			key: ai.toKey(1),
			delta: 6,
			retained: 6,
			requestId: 'request-1',
		}]);

		document.apply(StringEdit.insert(4, 'X'), user);

		assert.deepStrictEqual(snapshot(tracker), [
			{
				key: ai.toKey(1),
				delta: 6,
				retained: 4,
				requestId: 'request-1',
			},
			{
				key: 'source:cursor-kind:type',
				delta: 1,
				retained: 1,
				requestId: undefined,
			},
			{
				key: 'source:reloadFromDisk',
				delta: 0,
				retained: 0,
				requestId: undefined,
			},
		]);
	});

	test('joins level-one keys but keeps distinct model ids separate', () => {
		const document = disposables.add(new TestAnnotatedDocument(''));
		const tracker = disposables.add(new DocumentEditSourceTracker(document, undefined));
		const gptFirst = chatEditSource('gpt-5', 'request-1');
		const gptSecond = chatEditSource('gpt-5', 'request-2');
		const claude = chatEditSource('claude-sonnet', 'request-3');

		document.apply(StringEdit.insert(0, 'one'), gptFirst);
		document.apply(StringEdit.insert(3, 'two'), gptSecond);
		document.apply(StringEdit.insert(6, 'three'), claude);

		assert.deepStrictEqual(snapshot(tracker), [
			{
				key: claude.toKey(1),
				delta: 5,
				retained: 5,
				requestId: 'request-3',
			},
			{
				key: gptFirst.toKey(1),
				delta: 6,
				retained: 6,
				requestId: 'request-1',
			},
		]);
		assert.strictEqual(gptFirst.toKey(1), gptSecond.toKey(1));
	});

	test('suppresses matched external attribution while preserving range transforms', () => {
		const document = disposables.add(new TestAnnotatedDocument(''));
		const correlation = new TestExternalEditCorrelation();
		const tracker = disposables.add(new DocumentEditSourceTracker(document, undefined, correlation));
		const ai = chatEditSource('gpt-5', 'request-1');
		const user = EditSources.cursor({ kind: 'type' });

		document.apply(StringEdit.insert(0, 'abcdef'), ai);
		document.apply(StringEdit.delete(new OffsetRange(2, 4)), EditSources.reloadFromDisk());
		correlation.suppress(correlation.lastObservationId!);
		document.apply(StringEdit.insert(4, 'X'), user);

		assert.deepStrictEqual(snapshot(tracker), [
			{
				key: ai.toKey(1),
				delta: 6,
				retained: 4,
				requestId: 'request-1',
			},
			{
				key: 'source:cursor-kind:type',
				delta: 1,
				retained: 1,
				requestId: undefined,
			},
		]);
	});

	test('reattributes an initial external edit and preserves retention composition', () => {
		const document = disposables.add(new TestAnnotatedDocument('initial'));
		const correlation = new TestExternalEditCorrelation();
		const tracker = disposables.add(new DocumentEditSourceTracker(document, undefined, correlation, 'reattribute'));
		const agentHost = agentHostEditSource('gpt-5', 'turn-1', 'copilotcli');

		document.apply(StringEdit.replace(OffsetRange.ofLength(7), 'external'), EditSources.reloadFromDisk());
		tracker.applyPendingExternalEdits();
		correlation.resolve(correlation.lastObservationId!, agentHost);
		document.apply(StringEdit.replace(new OffsetRange(0, 3), 'X'), EditSources.cursor({ kind: 'type' }));

		const externalKey = tracker.getAllKeys().find(key => key.startsWith('external-observation:'))!;
		assert.deepStrictEqual({
			sourceKey: tracker.getRepresentative(externalKey)?.toKey(1),
			delta: tracker.getTotalInsertedCharactersCount(externalKey),
			retained: tracker.getTrackedRanges().filter(range => range.sourceKey === externalKey).reduce((sum, range) => sum + range.range.length, 0),
			category: tracker.getTrackedRanges().find(range => range.sourceKey === externalKey)?.source.category,
		}, {
			sourceKey: 'source:Chat.applyEdits-$modelId:gpt-5-$harness:copilotcli-$origin:agentHost',
			delta: 8,
			retained: 5,
			category: 'agentHost',
		});
	});

	test('restores external attribution when reattribution is invalidated', () => {
		const document = disposables.add(new TestAnnotatedDocument('initial'));
		const correlation = new TestExternalEditCorrelation();
		const tracker = disposables.add(new DocumentEditSourceTracker(document, undefined, correlation, 'reattribute'));

		document.apply(StringEdit.replace(OffsetRange.ofLength(7), 'external'), EditSources.reloadFromDisk());
		tracker.applyPendingExternalEdits();
		correlation.resolve(correlation.lastObservationId!, agentHostEditSource('gpt-5', 'turn-1', 'copilotcli'));
		correlation.invalidate(correlation.lastObservationId!);

		assert.deepStrictEqual(snapshot(tracker), [{
			key: 'external-observation:observation-1',
			delta: 8,
			retained: 8,
			requestId: undefined,
		}]);
	});
});

class TestAnnotatedDocument extends Disposable implements IDocumentWithAnnotatedEdits<EditKeySourceData> {
	private readonly _value: ISettableObservable<StringText, { edit: AnnotatedStringEdit<EditKeySourceData> }>;
	readonly value: IObservableWithChange<StringText, { edit: AnnotatedStringEdit<EditKeySourceData> }>;

	constructor(initialValue: string) {
		super();
		this.value = this._value = observableValue(this, new StringText(initialValue));
	}

	apply(edit: StringEdit, source: TextModelEditSource): void {
		const data = new EditSourceData(source).toEditSourceData();
		this._value.set(edit.applyOnText(this._value.get()), undefined, { edit: edit.mapData(() => data) });
	}

	waitForQueue(onDrained?: () => void | Promise<void>): Promise<void> {
		return Promise.resolve(onDrained?.());
	}
}

function chatEditSource(modelId: string, requestId: string): TextModelEditSource {
	return EditSources.chatApplyEdits({
		modelId,
		sessionId: 'session-1',
		requestId,
		languageId: 'typescript',
		mode: 'agent',
		extensionId: undefined,
		codeBlockSuggestionId: undefined,
	});
}

function agentHostEditSource(modelId: string, requestId: string, harness: string): TextModelEditSource {
	return EditSources.agentHostChatApplyEdits({
		modelId,
		sessionId: 'session-1',
		requestId,
		harness,
	});
}

function snapshot(tracker: DocumentEditSourceTracker, includeSuppressed = false): Array<{ key: string; delta: number; retained: number; requestId: string | undefined }> {
	const retained = new Map<string, number>();
	for (const range of tracker.getTrackedRanges(undefined, includeSuppressed)) {
		retained.set(range.sourceKey, (retained.get(range.sourceKey) ?? 0) + range.range.length);
	}
	return tracker.getAllKeys(includeSuppressed).map(key => ({
		key,
		delta: tracker.getTotalInsertedCharactersCount(key, includeSuppressed),
		retained: retained.get(key) ?? 0,
		requestId: tracker.getRepresentative(key)?.props.$$requestId,
	})).sort((a, b) => a.key.localeCompare(b.key));
}

class TestExternalEditCorrelation implements IExternalEditCorrelation {
	private readonly _onDidSuppress = new Emitter<string>();
	readonly onDidSuppress: Event<string> = this._onDidSuppress.event;
	private readonly _onDidResolve = new Emitter<IExternalEditCorrelationResolution>();
	readonly onDidResolve: Event<IExternalEditCorrelationResolution> = this._onDidResolve.event;
	private readonly _onDidInvalidate = new Emitter<string>();
	readonly onDidInvalidate: Event<string> = this._onDidInvalidate.event;
	private readonly _resolutions = new Map<string, IExternalEditCorrelationResolution>();
	private _sequence = 0;
	lastObservationId: string | undefined;

	register(_before: string, _after: string): string {
		return this.lastObservationId = `observation-${++this._sequence}`;
	}

	isSuppressed(id: string): boolean {
		return this._resolutions.has(id);
	}

	getResolution(id: string): IExternalEditCorrelationResolution | undefined {
		return this._resolutions.get(id);
	}

	waitForResolution(): Promise<void> {
		return Promise.resolve();
	}

	release(id: string): void {
		this._resolutions.delete(id);
	}

	suppress(id: string): void {
		const resolution = { id };
		this._resolutions.set(id, resolution);
		this._onDidSuppress.fire(id);
		this._onDidResolve.fire(resolution);
	}

	resolve(id: string, source: TextModelEditSource): void {
		const resolution = { id, source };
		this._resolutions.set(id, resolution);
		this._onDidSuppress.fire(id);
		this._onDidResolve.fire(resolution);
	}

	invalidate(id: string): void {
		this._resolutions.delete(id);
		this._onDidInvalidate.fire(id);
	}
}
