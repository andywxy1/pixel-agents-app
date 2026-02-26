/**
 * Electron preload script.
 * Bridges IPC between the main process and the renderer (React webview).
 *
 * - Exposes window.electronIpc.postMessage() for the React app to send messages
 * - Forwards main-process messages as window MessageEvents so the React app's
 *   existing window.addEventListener('message', ...) listeners work unchanged
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronIpc', {
	postMessage(msg: unknown): void {
		ipcRenderer.send('webview-message', msg);
	},
});

ipcRenderer.on('main-message', (_event, data: unknown) => {
	window.dispatchEvent(new MessageEvent('message', { data }));
});
