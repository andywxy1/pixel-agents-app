/**
 * macOS Terminal launcher for Electron.
 * Opens new Terminal.app windows running claude via AppleScript.
 */

import { exec } from 'child_process';
import type { ElectronTerminalHandle } from '../src/types.js';

/**
 * Launch a new Terminal.app window running `claude --session-id <sessionId>` in the given cwd.
 * Returns an ElectronTerminalHandle with the terminal process info.
 */
export function launchClaudeTerminal(
	name: string,
	sessionId: string,
	cwd: string,
): ElectronTerminalHandle {
	// Escape single quotes in path for AppleScript
	const safeCwd = cwd.replace(/'/g, "'\\''");
	const script = `tell application "Terminal"
	activate
	do script "cd '${safeCwd}' && claude --session-id ${sessionId}"
end tell`;

	let terminalPid = 0;
	exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err) => {
		if (err) {
			console.error(`[Pixel Agents] Failed to launch terminal: ${err.message}`);
		}
	});

	const handle: ElectronTerminalHandle = {
		pid: terminalPid,
		name,
		kill(): void {
			if (terminalPid) {
				exec(`kill ${terminalPid}`, (err) => {
					if (err) console.error(`[Pixel Agents] Failed to kill terminal ${terminalPid}: ${err.message}`);
				});
			}
		},
	};

	return handle;
}

/**
 * Open a directory in Finder.
 */
export function openDirectory(dirPath: string): void {
	exec(`open "${dirPath.replace(/"/g, '\\"')}"`, (err) => {
		if (err) console.error(`[Pixel Agents] Failed to open directory: ${err.message}`);
	});
}
