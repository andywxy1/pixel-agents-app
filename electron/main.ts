/**
 * Electron main process — replaces extension.ts + PixelAgentsViewProvider.ts.
 * Orchestrates: BrowserWindow, IPC, agent lifecycle, asset loading, layout persistence.
 */

import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import type { AgentState } from '../src/types.js';
import {
	launchNewTerminal,
	removeAgent,
	persistAgents,
	restoreAgents,
	sendExistingAgents,
	sendLayout,
	getClaudeProjectsRoot,
} from '../src/agentManager.js';
import { ensureMultiProjectScan } from '../src/fileWatcher.js';
import {
	loadFurnitureAssets,
	sendAssetsToWebview,
	loadFloorTiles,
	sendFloorTilesToWebview,
	loadWallTiles,
	sendWallTilesToWebview,
	loadCharacterSprites,
	sendCharacterSpritesToWebview,
	loadDefaultLayout,
} from '../src/assetLoader.js';
import { writeLayoutToFile, readLayoutFromFile, watchLayoutFile } from '../src/layoutPersistence.js';
import type { LayoutWatcher } from '../src/layoutPersistence.js';
import { setAgentSeats, getSoundEnabled, setSoundEnabled, getWorkingDirectory, setWorkingDirectory } from './appState.js';
import { openDirectory } from './terminalLauncher.js';

// ── State ─────────────────────────────────────────────────────

const nextAgentId = { current: 1 };
const nextTerminalIndex = { current: 1 };
const agents = new Map<number, AgentState>();
const fileWatchers = new Map<number, ReturnType<typeof import('fs').watch>>();
const pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
const jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();
const projectScanTimer = { current: null as ReturnType<typeof setInterval> | null };
const knownJsonlFiles = new Set<string>();

let layoutWatcher: LayoutWatcher | null = null;
let mainWindow: BrowserWindow | null = null;

type Webview = { postMessage(msg: unknown): void } | undefined;

// ── Webview message factory ───────────────────────────────────

function makePostMessage(win: BrowserWindow): { postMessage(msg: unknown): void } {
	return {
		postMessage(msg: unknown): void {
			if (!win.isDestroyed()) {
				win.webContents.send('main-message', msg);
			}
		},
	};
}

function getWebview(): Webview {
	if (!mainWindow || mainWindow.isDestroyed()) return undefined;
	return makePostMessage(mainWindow);
}

// ── Asset & path resolution ───────────────────────────────────

/**
 * Returns the root directory that contains an 'assets/' subfolder.
 * Priority: packaged resources → dist/ → webview-ui/public/
 */
function getAssetsRoot(): string {
	if (app.isPackaged) {
		return process.resourcesPath;
	}
	// Development: dist/electron/main.js → __dirname = dist/electron
	const distRoot = path.join(__dirname, '..');
	if (fs.existsSync(path.join(distRoot, 'assets'))) {
		return distRoot;
	}
	// Fallback: source assets (before esbuild copy)
	const sourceAssets = path.join(__dirname, '..', '..', 'webview-ui', 'public');
	if (fs.existsSync(path.join(sourceAssets, 'assets'))) {
		return sourceAssets;
	}
	return distRoot;
}

function getWebviewHtmlPath(): string {
	if (app.isPackaged) {
		return path.join(__dirname, '..', 'webview', 'index.html');
	}
	return path.join(__dirname, '..', 'webview', 'index.html');
}

// ── Persist helper ────────────────────────────────────────────

function doPersistAgents(): void {
	persistAgents(agents);
}

// ── Window creation ───────────────────────────────────────────

function createWindow(): void {
	const preloadPath = path.join(__dirname, 'preload.js');

	mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
		title: 'Pixel Agents',
		webPreferences: {
			preload: preloadPath,
			nodeIntegration: false,
			contextIsolation: true,
		},
	});

	// Load from Vite dev server in dev mode, otherwise built HTML
	const devUrl = process.env['ELECTRON_DEV_URL'];
	if (devUrl) {
		mainWindow.loadURL(devUrl);
		mainWindow.webContents.openDevTools();
	} else {
		const htmlPath = getWebviewHtmlPath();
		mainWindow.loadFile(htmlPath);
	}

	mainWindow.on('closed', () => {
		mainWindow = null;
	});

	setupMenu();
}

// ── IPC: inbound messages from webview ───────────────────────

ipcMain.on('webview-message', async (_event, message: Record<string, unknown>) => {
	const webview = getWebview();

	if (message.type === 'webviewReady') {
		await handleWebviewReady();
	} else if (message.type === 'openClaude') {
		const cwd = getWorkingDirectory();
		launchNewTerminal(
			nextAgentId, nextTerminalIndex,
			agents, knownJsonlFiles,
			fileWatchers, pollingTimers, waitingTimers, permissionTimers,
			jsonlPollTimers, projectScanTimer,
			webview, cwd, doPersistAgents,
		);
	} else if (message.type === 'focusAgent') {
		// Bring Terminal.app to foreground (best-effort on macOS)
		const { exec } = await import('child_process');
		exec('osascript -e \'tell application "Terminal" to activate\'');
	} else if (message.type === 'closeAgent') {
		const id = message.id as number;
		removeAgent(
			id, agents,
			fileWatchers, pollingTimers, waitingTimers, permissionTimers,
			jsonlPollTimers, doPersistAgents,
		);
		webview?.postMessage({ type: 'agentClosed', id });
	} else if (message.type === 'saveAgentSeats') {
		console.log(`[Pixel Agents] saveAgentSeats:`, JSON.stringify(message.seats));
		setAgentSeats(message.seats as Record<string, { palette?: number; seatId?: string }>);
	} else if (message.type === 'saveLayout') {
		layoutWatcher?.markOwnWrite();
		writeLayoutToFile(message.layout as Record<string, unknown>);
	} else if (message.type === 'setSoundEnabled') {
		setSoundEnabled(message.enabled as boolean);
	} else if (message.type === 'openSessionsFolder') {
		const claudeProjectsRoot = getClaudeProjectsRoot();
		if (fs.existsSync(claudeProjectsRoot)) {
			openDirectory(claudeProjectsRoot);
		}
	} else if (message.type === 'exportLayout') {
		await handleExportLayout();
	} else if (message.type === 'importLayout') {
		await handleImportLayout(webview);
	}
});

// ── Webview ready: restore state + load assets ────────────────

async function handleWebviewReady(): Promise<void> {
	const webview = getWebview();
	if (!webview) return;

	// Send settings
	const soundEnabled = getSoundEnabled();
	webview.postMessage({ type: 'settingsLoaded', soundEnabled });

	// Restore agents from persisted state
	restoreAgents(
		nextAgentId, nextTerminalIndex,
		agents, knownJsonlFiles,
		fileWatchers, pollingTimers, waitingTimers, permissionTimers,
		jsonlPollTimers, projectScanTimer,
		webview, doPersistAgents,
	);

	// Ensure multi-project scan is running (catches new sessions started in any terminal)
	const claudeProjectsRoot = getClaudeProjectsRoot();
	ensureMultiProjectScan(
		claudeProjectsRoot, knownJsonlFiles, projectScanTimer,
		nextAgentId, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
		webview, doPersistAgents,
	);

	// Load assets
	const assetsRoot = getAssetsRoot();
	console.log('[Electron] Using assetsRoot:', assetsRoot);

	let defaultLayout: Record<string, unknown> | null = null;

	try {
		defaultLayout = loadDefaultLayout(assetsRoot);

		const charSprites = await loadCharacterSprites(assetsRoot);
		if (charSprites) sendCharacterSpritesToWebview(webview, charSprites);

		const floorTiles = await loadFloorTiles(assetsRoot);
		if (floorTiles) sendFloorTilesToWebview(webview, floorTiles);

		const wallTiles = await loadWallTiles(assetsRoot);
		if (wallTiles) sendWallTilesToWebview(webview, wallTiles);

		const furnitureAssets = await loadFurnitureAssets(assetsRoot);
		if (furnitureAssets) sendAssetsToWebview(webview, furnitureAssets);
	} catch (err) {
		console.error('[Electron] Error loading assets:', err);
	}

	// Send layout (after assets so catalog is built)
	sendLayout(webview, defaultLayout);

	// Start layout file watcher for cross-process sync
	startLayoutWatcher();

	// Send existing agents to webview
	sendExistingAgents(agents, webview);
}

// ── Layout file watcher ───────────────────────────────────────

function startLayoutWatcher(): void {
	if (layoutWatcher) return;
	layoutWatcher = watchLayoutFile((layout) => {
		console.log('[Electron] External layout change — pushing to webview');
		getWebview()?.postMessage({ type: 'layoutLoaded', layout });
	});
}

// ── Export / Import layout ────────────────────────────────────

async function handleExportLayout(): Promise<void> {
	if (!mainWindow) return;
	const layout = readLayoutFromFile();
	if (!layout) {
		dialog.showErrorBox('Pixel Agents', 'No saved layout to export.');
		return;
	}
	const result = await dialog.showSaveDialog(mainWindow, {
		defaultPath: path.join(os.homedir(), 'pixel-agents-layout.json'),
		filters: [{ name: 'JSON Files', extensions: ['json'] }],
	});
	if (!result.canceled && result.filePath) {
		fs.writeFileSync(result.filePath, JSON.stringify(layout, null, 2), 'utf-8');
	}
}

async function handleImportLayout(webview: Webview): Promise<void> {
	if (!mainWindow) return;
	const result = await dialog.showOpenDialog(mainWindow, {
		filters: [{ name: 'JSON Files', extensions: ['json'] }],
		properties: ['openFile'],
	});
	if (result.canceled || result.filePaths.length === 0) return;
	try {
		const raw = fs.readFileSync(result.filePaths[0], 'utf-8');
		const imported = JSON.parse(raw) as Record<string, unknown>;
		if (imported.version !== 1 || !Array.isArray(imported.tiles)) {
			dialog.showErrorBox('Pixel Agents', 'Invalid layout file.');
			return;
		}
		layoutWatcher?.markOwnWrite();
		writeLayoutToFile(imported);
		webview?.postMessage({ type: 'layoutLoaded', layout: imported });
	} catch {
		dialog.showErrorBox('Pixel Agents', 'Failed to read or parse layout file.');
	}
}

// ── Native Mac menu ───────────────────────────────────────────

function setupMenu(): void {
	const template: Electron.MenuItemConstructorOptions[] = [
		{
			label: app.name,
			submenu: [
				{ role: 'about' },
				{ type: 'separator' },
				{
					label: 'Export Layout as Default',
					click: (): void => {
						const layout = readLayoutFromFile();
						if (!layout) {
							dialog.showErrorBox('Pixel Agents', 'No saved layout found.');
							return;
						}
						// Write to webview-ui/public/assets/ for dev use
						const devPath = path.join(__dirname, '..', '..', 'webview-ui', 'public', 'assets', 'default-layout.json');
						if (fs.existsSync(path.dirname(devPath))) {
							fs.writeFileSync(devPath, JSON.stringify(layout, null, 2), 'utf-8');
							dialog.showMessageBox({ message: `Default layout exported to ${devPath}` });
						}
					},
				},
				{
					label: 'Set Working Directory…',
					click: async (): Promise<void> => {
						if (!mainWindow) return;
						const result = await dialog.showOpenDialog(mainWindow, {
							properties: ['openDirectory'],
							defaultPath: getWorkingDirectory(),
						});
						if (!result.canceled && result.filePaths.length > 0) {
							setWorkingDirectory(result.filePaths[0]);
						}
					},
				},
				{ type: 'separator' },
				{ role: 'services' },
				{ type: 'separator' },
				{ role: 'hide' },
				{ role: 'hideOthers' },
				{ role: 'unhide' },
				{ type: 'separator' },
				{ role: 'quit' },
			],
		},
		{
			label: 'Edit',
			submenu: [
				{ role: 'undo' },
				{ role: 'redo' },
				{ type: 'separator' },
				{ role: 'cut' },
				{ role: 'copy' },
				{ role: 'paste' },
				{ role: 'selectAll' },
			],
		},
		{
			label: 'View',
			submenu: [
				{ role: 'reload' },
				{ role: 'forceReload' },
				{ role: 'toggleDevTools' },
				{ type: 'separator' },
				{ role: 'resetZoom' },
				{ role: 'zoomIn' },
				{ role: 'zoomOut' },
				{ type: 'separator' },
				{ role: 'togglefullscreen' },
			],
		},
		{
			label: 'Window',
			submenu: [
				{ role: 'minimize' },
				{ role: 'zoom' },
				{ type: 'separator' },
				{ role: 'front' },
			],
		},
	];

	const menu = Menu.buildFromTemplate(template);
	Menu.setApplicationMenu(menu);
}

// ── App lifecycle ─────────────────────────────────────────────

app.whenReady().then(() => {
	createWindow();

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

app.on('before-quit', () => {
	layoutWatcher?.dispose();
	layoutWatcher = null;
	if (projectScanTimer.current) {
		clearInterval(projectScanTimer.current);
		projectScanTimer.current = null;
	}
	// Clean up all agents
	for (const id of [...agents.keys()]) {
		removeAgent(
			id, agents,
			fileWatchers, pollingTimers, waitingTimers, permissionTimers,
			jsonlPollTimers, doPersistAgents,
		);
	}
});

// Suppress default Electron menu on non-Mac
if (process.platform !== 'darwin') {
	app.on('ready', () => {
		Menu.setApplicationMenu(null);
	});
}
