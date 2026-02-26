import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AgentState, PersistedAgent } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer } from './timerManager.js';
import { startFileWatching, readNewLines, ensureMultiProjectScan } from './fileWatcher.js';
import { JSONL_POLL_INTERVAL_MS, TERMINAL_NAME_PREFIX } from './constants.js';
import { migrateAndLoadLayout } from './layoutPersistence.js';
import { launchClaudeTerminal } from '../electron/terminalLauncher.js';
import { getAgents, setAgents, getAgentSeats } from '../electron/appState.js';

type Webview = { postMessage(msg: unknown): void } | undefined;

/** How long a JSONL file must have been modified within to be considered "live" on restore */
const RESTORE_LIVENESS_MS = 30 * 60 * 1000; // 30 minutes

export function getClaudeProjectsRoot(): string {
	return path.join(os.homedir(), '.claude', 'projects');
}

export function getProjectDirPath(cwd?: string): string | null {
	const workspacePath = cwd || os.homedir();
	const dirName = workspacePath.replace(/[:\\/]/g, '-');
	return path.join(os.homedir(), '.claude', 'projects', dirName);
}

export function launchNewTerminal(
	nextAgentIdRef: { current: number },
	nextTerminalIndexRef: { current: number },
	agents: Map<number, AgentState>,
	knownJsonlFiles: Set<string>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
	webview: Webview,
	cwd: string,
	persistAgentsFn: () => void,
): void {
	const idx = nextTerminalIndexRef.current++;
	const name = `${TERMINAL_NAME_PREFIX} #${idx}`;
	const sessionId = crypto.randomUUID();

	const projectDir = getProjectDirPath(cwd);
	if (!projectDir) {
		console.log(`[Pixel Agents] No project dir, cannot track agent`);
		return;
	}

	// Launch Terminal.app window
	const terminalHandle = launchClaudeTerminal(name, sessionId, cwd);

	// Pre-register expected JSONL file so multi-project scan won't create a duplicate agent
	const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
	knownJsonlFiles.add(expectedFile);

	// Create agent immediately (before JSONL file exists)
	const id = nextAgentIdRef.current++;
	const agent: AgentState = {
		id,
		terminalRef: terminalHandle,
		projectDir,
		jsonlFile: expectedFile,
		fileOffset: 0,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		permissionSent: false,
		hadToolsInTurn: false,
	};

	agents.set(id, agent);
	persistAgentsFn();
	console.log(`[Pixel Agents] Agent ${id}: created for terminal ${name}`);
	webview?.postMessage({ type: 'agentCreated', id });

	const claudeProjectsRoot = getClaudeProjectsRoot();
	ensureMultiProjectScan(
		claudeProjectsRoot, knownJsonlFiles, projectScanTimerRef,
		nextAgentIdRef, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
		webview, persistAgentsFn,
	);

	// Poll for the specific JSONL file to appear
	const pollTimer = setInterval(() => {
		try {
			if (fs.existsSync(agent.jsonlFile)) {
				console.log(`[Pixel Agents] Agent ${id}: found JSONL file ${path.basename(agent.jsonlFile)}`);
				clearInterval(pollTimer);
				jsonlPollTimers.delete(id);
				startFileWatching(id, agent.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
				readNewLines(id, agents, waitingTimers, permissionTimers, webview);
			}
		} catch { /* file may not exist yet */ }
	}, JSONL_POLL_INTERVAL_MS);
	jsonlPollTimers.set(id, pollTimer);
}

export function removeAgent(
	agentId: number,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	persistAgentsFn: () => void,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	// Stop JSONL poll timer
	const jpTimer = jsonlPollTimers.get(agentId);
	if (jpTimer) { clearInterval(jpTimer); }
	jsonlPollTimers.delete(agentId);

	// Stop file watching
	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const pt = pollingTimers.get(agentId);
	if (pt) { clearInterval(pt); }
	pollingTimers.delete(agentId);

	// Cancel timers
	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);

	// Kill terminal if possible
	try { agent.terminalRef.kill(); } catch { /* ignore */ }

	// Remove from maps
	agents.delete(agentId);
	persistAgentsFn();
}

export function persistAgents(agents: Map<number, AgentState>): void {
	const persisted: PersistedAgent[] = [];
	for (const agent of agents.values()) {
		persisted.push({
			id: agent.id,
			terminalName: agent.terminalRef.name,
			jsonlFile: agent.jsonlFile,
			projectDir: agent.projectDir,
			pid: agent.terminalRef.pid,
		});
	}
	setAgents(persisted);
}

export function restoreAgents(
	nextAgentIdRef: { current: number },
	nextTerminalIndexRef: { current: number },
	agents: Map<number, AgentState>,
	knownJsonlFiles: Set<string>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
	webview: Webview,
	doPersist: () => void,
): void {
	const persisted = getAgents();
	if (persisted.length === 0) return;

	const now = Date.now();
	let maxId = 0;
	let maxIdx = 0;

	for (const p of persisted) {
		// Liveness check: JSONL file must exist and have been modified recently
		let isLive = false;
		try {
			if (fs.existsSync(p.jsonlFile)) {
				const stat = fs.statSync(p.jsonlFile);
				isLive = (now - stat.mtimeMs) < RESTORE_LIVENESS_MS;
			}
		} catch { /* ignore */ }

		if (!isLive) {
			console.log(`[Pixel Agents] Skipping stale agent ${p.id} (${path.basename(p.jsonlFile)})`);
			continue;
		}

		const agent: AgentState = {
			id: p.id,
			terminalRef: { pid: p.pid, name: p.terminalName, kill(): void {} },
			projectDir: p.projectDir,
			jsonlFile: p.jsonlFile,
			fileOffset: 0,
			lineBuffer: '',
			activeToolIds: new Set(),
			activeToolStatuses: new Map(),
			activeToolNames: new Map(),
			activeSubagentToolIds: new Map(),
			activeSubagentToolNames: new Map(),
			isWaiting: false,
			permissionSent: false,
			hadToolsInTurn: false,
		};

		agents.set(p.id, agent);
		knownJsonlFiles.add(p.jsonlFile);
		console.log(`[Pixel Agents] Restored agent ${p.id} (${path.basename(p.jsonlFile)})`);

		if (p.id > maxId) maxId = p.id;
		const match = p.terminalName.match(/#(\d+)$/);
		if (match) {
			const idx = parseInt(match[1], 10);
			if (idx > maxIdx) maxIdx = idx;
		}

		// Start file watching, skipping to end of file
		try {
			if (fs.existsSync(p.jsonlFile)) {
				const stat = fs.statSync(p.jsonlFile);
				agent.fileOffset = stat.size;
				startFileWatching(p.id, p.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
			} else {
				const pollTimer = setInterval(() => {
					try {
						if (fs.existsSync(agent.jsonlFile)) {
							console.log(`[Pixel Agents] Restored agent ${p.id}: found JSONL file`);
							clearInterval(pollTimer);
							jsonlPollTimers.delete(p.id);
							const stat = fs.statSync(agent.jsonlFile);
							agent.fileOffset = stat.size;
							startFileWatching(p.id, agent.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
						}
					} catch { /* file may not exist yet */ }
				}, JSONL_POLL_INTERVAL_MS);
				jsonlPollTimers.set(p.id, pollTimer);
			}
		} catch { /* ignore errors during restore */ }
	}

	// Advance counters past restored IDs
	if (maxId >= nextAgentIdRef.current) {
		nextAgentIdRef.current = maxId + 1;
	}
	if (maxIdx >= nextTerminalIndexRef.current) {
		nextTerminalIndexRef.current = maxIdx + 1;
	}

	// Re-persist cleaned-up list (removes stale entries)
	doPersist();

	// Start multi-project scan for new JSONL detection
	const claudeProjectsRoot = getClaudeProjectsRoot();
	ensureMultiProjectScan(
		claudeProjectsRoot, knownJsonlFiles, projectScanTimerRef,
		nextAgentIdRef, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
		webview, doPersist,
	);
}

export function sendExistingAgents(
	agents: Map<number, AgentState>,
	webview: Webview,
): void {
	if (!webview) return;
	const agentIds: number[] = [];
	for (const id of agents.keys()) {
		agentIds.push(id);
	}
	agentIds.sort((a, b) => a - b);

	const agentMeta = getAgentSeats();
	console.log(`[Pixel Agents] sendExistingAgents: agents=${JSON.stringify(agentIds)}, meta=${JSON.stringify(agentMeta)}`);

	webview.postMessage({
		type: 'existingAgents',
		agents: agentIds,
		agentMeta,
	});

	sendCurrentAgentStatuses(agents, webview);
}

export function sendCurrentAgentStatuses(
	agents: Map<number, AgentState>,
	webview: Webview,
): void {
	if (!webview) return;
	for (const [agentId, agent] of agents) {
		// Re-send active tools
		for (const [toolId, status] of agent.activeToolStatuses) {
			webview.postMessage({
				type: 'agentToolStart',
				id: agentId,
				toolId,
				status,
			});
		}
		// Re-send waiting status
		if (agent.isWaiting) {
			webview.postMessage({
				type: 'agentStatus',
				id: agentId,
				status: 'waiting',
			});
		}
	}
}

export function sendLayout(
	webview: Webview,
	defaultLayout?: Record<string, unknown> | null,
): void {
	if (!webview) return;
	const layout = migrateAndLoadLayout(defaultLayout);
	webview.postMessage({
		type: 'layoutLoaded',
		layout,
	});
}
