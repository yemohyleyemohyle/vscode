/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { runWithFakedTimers } from '../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IFileService } from '../../../files/common/files.js';
import { TestInstantiationService } from '../../../instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../log/common/log.js';
import { ITelemetryService, TelemetryLevel } from '../../../telemetry/common/telemetry.js';
import { type IAgentHostManagementService, IAgentService, type IConnectionTrackerService } from '../../common/agentService.js';
import { IDiffComputeService } from '../../common/diffComputeService.js';
import { IAgentEditAttributionService } from '../../common/fileEditAttribution.js';
import { type IRequestEditSurvivalBoundary, type IRequestFocusWindowSurvivalSnapshot, unavailableRequestEditSurvivalSnapshots } from '../../common/requestEditSurvival.js';
import { ISessionDataService } from '../../common/sessionDataService.js';
import { IAgentHostMacAccessibilityTrustService } from '../../node/agentHostMacAccessibilityTrustService.js';
import { AgentHostManagementService } from '../../node/agentHostManagementService.js';
import { IAgentHostSystemWakeService } from '../../node/agentHostSystemWakeService.js';
import { AgentEditAttributionService } from '../../node/shared/agentEditAttributionService.js';

suite('Request Focus Window Survival', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const boundary: IRequestEditSurvivalBoundary = {
		sessionId: 'session', chatId: 'chat', observationRequestId: 'request',
		observationBoundary: 'requestStart', observationTimestamp: '2026-01-01T00:00:00.000Z',
	};
	let previousFlag: string | undefined;
	setup(() => {
		previousFlag = process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG;
		process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG = '1';
	});
	teardown(() => {
		if (previousFlag === undefined) {
			delete process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG;
		} else {
			process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG = previousFlag;
		}
	});

	test('round-trips boundary and per-document snapshots through local management IPC without backend telemetry', async () => {
		const { service, management, log, backendEvents } = createServices();
		const received: IRequestEditSurvivalBoundary[] = [];
		disposables.add(management.onDidRequestFocusWindowSnapshot(event => received.push(event)));
		service.requestFocusWindowSnapshot(boundary);
		const snapshots = measuredSnapshots();
		await management.logFocusWindowSnapshots(snapshots);
		await management.logFocusWindowSnapshots(snapshots);
		assert.deepStrictEqual({ received, records: log.records, backendEvents }, {
			received: [boundary], records: snapshots.map(({ reason: _reason, ...record }) => record), backendEvents: [],
		});
	});

	test('reports absent renderers, respects the experiment flag and does not buffer disconnected boundaries', () => {
		const { service, management, log } = createServices();
		service.requestFocusWindowSnapshot(boundary);
		const received: IRequestEditSurvivalBoundary[] = [];
		const listener = management.onDidRequestFocusWindowSnapshot(event => received.push(event));
		listener.dispose();
		service.requestFocusWindowSnapshot({ ...boundary, observationBoundary: 'requestEnd' });
		process.env.VSCODE_AGENT_HOST_REQUEST_DIFF_SURVIVAL_LOG = '0';
		service.requestFocusWindowSnapshot(boundary);
		assert.deepStrictEqual({
			received,
			records: log.records.map(record => ({ boundary: record.observationBoundary, status: record.status, reason: record.reason, sources: record.sources, document: record.documentUri })),
		}, {
			received: [],
			records: ['requestStart', 'requestEnd'].flatMap(boundary => [0, 1, 2].map(() => ({
				boundary, status: 'error', reason: 'transportError', sources: [], document: null,
			}))),
		});
	});

	test('reports a bounded transport timeout once and ignores late replies', () => runWithFakedTimers({}, async () => {
		const { service, management, log, store } = createServices();
		try {
			store.add(management.onDidRequestFocusWindowSnapshot(() => { }));
			service.requestFocusWindowSnapshot(boundary);
			await timeout(15_001);
			await management.logFocusWindowSnapshots(measuredSnapshots());
			assert.deepStrictEqual(log.records.map(record => ({
				mode: record.mode, status: record.status, complete: record.complete, reason: record.reason, sources: record.sources,
			})), ['10minFocusWindow', '20minFocusWindow', 'longterm'].map(mode => ({
				mode, status: 'error', complete: false, reason: 'transportError', sources: [],
			})));
		} finally {
			store.dispose();
		}
	}));

	test('redacts in-flight counters when consent changes and reports disabled collection', async () => {
		const { service, management, log, telemetry, backendEvents } = createServices();
		const received: IRequestEditSurvivalBoundary[] = [];
		disposables.add(management.onDidRequestFocusWindowSnapshot(event => received.push(event)));
		service.requestFocusWindowSnapshot(boundary);
		telemetry.telemetryLevel = TelemetryLevel.NONE;
		await management.logFocusWindowSnapshots(measuredSnapshots());
		service.requestFocusWindowSnapshot({ ...boundary, observationBoundary: 'requestEnd' });
		telemetry.telemetryLevel = TelemetryLevel.USAGE;
		service.setEnabled(false);
		service.requestFocusWindowSnapshot({ ...boundary, observationRequestId: 'disabled-request' });
		assert.deepStrictEqual({
			received, backendEvents,
			records: log.records.map(record => ({ status: record.status, reason: record.reason, document: record.documentUri, id: record.trackerInstanceId, sources: record.sources })),
		}, {
			received: [boundary], backendEvents: [],
			records: Array.from({ length: 9 }, () => ({ status: 'unavailable', reason: 'collectionDisabled', document: null, id: null, sources: [] })),
		});
	});

	function measuredSnapshots(): IRequestFocusWindowSurvivalSnapshot[] {
		return unavailableRequestEditSurvivalSnapshots(boundary, 'noActiveTracker').map(record => ({
			...record, status: 'complete', complete: true, reason: undefined,
			documentUri: 'file:///open.ts', trackerInstanceId: `tracker-${record.mode}`,
			windowStartTimestamp: boundary.observationTimestamp, elapsedFocusTimeMs: 100, elapsedWallTimeMs: 200,
			sources: [{ sourceKey: 'source:cursor', modelId: null, modifiedCount: 2, deltaModifiedCount: 3 }],
		}));
	}

	function createServices() {
		const store = disposables.add(new DisposableStore());
		const instantiationService = store.add(new TestInstantiationService());
		const log = new SnapshotLogService();
		const backendEvents: string[] = [];
		const telemetry = { telemetryLevel: TelemetryLevel.USAGE, publicLog2: (name: string) => backendEvents.push(name) };
		instantiationService.stub(IFileService, {});
		instantiationService.stub(IDiffComputeService, {});
		instantiationService.stub(ITelemetryService, telemetry);
		instantiationService.stub(ILogService, log);
		instantiationService.stub(IAgentService, {});
		const connectionTracker: IConnectionTrackerService = {
			onDidChangeConnectionCount: Event.None,
			waitForConfiguredWebSocketServer: async () => { },
			startWebSocketServer: async () => { throw new Error('Not used by snapshot collection'); },
			getInspectInfo: async () => undefined,
		};
		instantiationService.stub(ISessionDataService, {});
		instantiationService.stub(IAgentHostSystemWakeService, {});
		instantiationService.stub(IAgentHostMacAccessibilityTrustService, {});
		const service = store.add(instantiationService.createInstance(AgentEditAttributionService, async () => undefined, undefined));
		instantiationService.stub(IAgentEditAttributionService, service);
		const facade = instantiationService.createInstance(AgentHostManagementService, instantiationService.get(IAgentService), connectionTracker, async () => { });
		const server = ProxyChannel.fromService(facade, store.add(new DisposableStore()), { unbufferedEvents: ['onDidRequestFocusWindowSnapshot'] });
		const management = ProxyChannel.toService<IAgentHostManagementService>({
			call: (command, args, token) => server.call(undefined, command, args, token),
			listen: (event, args) => server.listen(undefined, event, args),
		});
		return { service, management, log, backendEvents, telemetry, store };
	}
});

class SnapshotLogService extends NullLogService {
	readonly records: IRequestFocusWindowSurvivalSnapshot[] = [];
	override info(message: string): void {
		const prefix = '[RequestFocusWindowSurvivalSnapshot] ';
		if (message.startsWith(prefix)) {
			this.records.push(JSON.parse(message.slice(prefix.length)));
		}
	}
}
