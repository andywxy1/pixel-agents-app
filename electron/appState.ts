/**
 * Persistent state for the Electron app.
 * Replaces VS Code's workspaceState / globalState.
 * Files stored in ~/.pixel-agents/
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PersistedAgent } from '../src/types.js';

const APP_DIR = path.join(os.homedir(), '.pixel-agents');
const AGENTS_FILE = path.join(APP_DIR, 'agents.json');
const AGENT_SEATS_FILE = path.join(APP_DIR, 'agent-seats.json');
const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');
const WORKING_DIR_FILE = path.join(APP_DIR, 'working-directory.json');

function ensureAppDir(): void {
	if (!fs.existsSync(APP_DIR)) {
		fs.mkdirSync(APP_DIR, { recursive: true });
	}
}

function atomicWrite(filePath: string, data: unknown): void {
	ensureAppDir();
	const tmp = filePath + '.tmp';
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
	fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string, fallback: T): T {
	try {
		if (!fs.existsSync(filePath)) return fallback;
		return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
	} catch {
		return fallback;
	}
}

export function getAgents(): PersistedAgent[] {
	return readJson<PersistedAgent[]>(AGENTS_FILE, []);
}

export function setAgents(agents: PersistedAgent[]): void {
	atomicWrite(AGENTS_FILE, agents);
}

export function getAgentSeats(): Record<string, { palette?: number; seatId?: string }> {
	return readJson<Record<string, { palette?: number; seatId?: string }>>(AGENT_SEATS_FILE, {});
}

export function setAgentSeats(seats: Record<string, { palette?: number; seatId?: string }>): void {
	atomicWrite(AGENT_SEATS_FILE, seats);
}

export function getSoundEnabled(): boolean {
	const settings = readJson<{ soundEnabled?: boolean }>(SETTINGS_FILE, {});
	return settings.soundEnabled !== false; // default true
}

export function setSoundEnabled(enabled: boolean): void {
	const settings = readJson<Record<string, unknown>>(SETTINGS_FILE, {});
	settings.soundEnabled = enabled;
	atomicWrite(SETTINGS_FILE, settings);
}

export function getWorkingDirectory(): string {
	const data = readJson<{ cwd?: string }>(WORKING_DIR_FILE, {});
	return data.cwd || os.homedir();
}

export function setWorkingDirectory(dir: string): void {
	atomicWrite(WORKING_DIR_FILE, { cwd: dir });
}
