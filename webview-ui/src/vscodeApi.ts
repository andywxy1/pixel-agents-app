declare global {
	interface Window {
		electronIpc?: { postMessage(msg: unknown): void }
	}
}

function createApi(): { postMessage(msg: unknown): void } {
	if (typeof window !== 'undefined' && window.electronIpc) {
		return window.electronIpc;
	}
	// Fallback: no-op (e.g., running in plain browser for development)
	return {
		postMessage(_msg: unknown): void {
			// no-op
		},
	};
}

export const vscode = createApi();
