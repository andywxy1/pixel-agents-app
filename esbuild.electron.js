const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Copy assets folder to dist/assets
 */
function copyAssets() {
	const srcDir = path.join(__dirname, 'webview-ui', 'public', 'assets');
	const dstDir = path.join(__dirname, 'dist', 'assets');

	if (fs.existsSync(srcDir)) {
		if (fs.existsSync(dstDir)) {
			fs.rmSync(dstDir, { recursive: true });
		}
		fs.cpSync(srcDir, dstDir, { recursive: true });
		console.log('✓ Copied assets/ → dist/assets/');
	} else {
		console.log('ℹ️  assets/ folder not found (optional)');
	}
}

/** @type {import('esbuild').Plugin} */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',
	setup(build) {
		build.onStart(() => console.log('[watch] build started'));
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	// Bundle: electron/main.ts → dist/electron/main.js
	const mainCtx = await esbuild.context({
		entryPoints: ['electron/main.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/electron/main.js',
		external: ['electron'],
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});

	// Bundle: electron/preload.ts → dist/electron/preload.js
	const preloadCtx = await esbuild.context({
		entryPoints: ['electron/preload.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/electron/preload.js',
		external: ['electron'],
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});

	if (watch) {
		await Promise.all([mainCtx.watch(), preloadCtx.watch()]);
	} else {
		await mainCtx.rebuild();
		await preloadCtx.rebuild();
		await mainCtx.dispose();
		await preloadCtx.dispose();
		copyAssets();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
