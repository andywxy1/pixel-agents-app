# Contributing to Pixel Agents

Thanks for your interest in contributing to Pixel Agents! All contributions are welcome — features, bug fixes, documentation improvements, refactors, and more.

This project is licensed under the [MIT License](LICENSE), so your contributions will be too. No CLA or DCO is required.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS recommended)

### Setup

```bash
git clone https://github.com/andywxy1/pixel-agents-app.git
cd pixel-agents-app
npm install
cd webview-ui && npm install && cd ..
npm run build
```

Then run `npm run start` to launch the app, or `npm run start:dev` for development with hot reload.

## Development Workflow

For development with live rebuilds, run in separate terminals:

```bash
npm run watch:electron-main   # watch main process
npm run watch:webview          # vite dev server
npm run start:dev              # launch with dev URL
```

### Project Structure

| Directory | Description |
|---|---|
| `electron/` | Electron main process — BrowserWindow, IPC, terminal launching |
| `src/` | Shared backend — agent management, file watching, JSONL parsing |
| `webview-ui/` | React + TypeScript frontend (separate Vite project) |
| `scripts/` | Asset extraction and generation tooling |

## Code Guidelines

### Constants

**No unused locals or parameters** (`noUnusedLocals` and `noUnusedParameters` are enabled): All magic numbers and strings are centralized — don't add inline constants to source files:

- **Backend:** `src/constants.ts`
- **Webview:** `webview-ui/src/constants.ts`
- **CSS variables:** `webview-ui/src/index.css` `:root` block (`--pixel-*` properties)

### UI Styling

The project uses a pixel art aesthetic. All overlays should use:

- Sharp corners (`border-radius: 0`)
- Solid backgrounds and `2px solid` borders
- Hard offset shadows (`2px 2px 0px`, no blur)
- The FS Pixel Sans font (loaded in `index.css`)

## Submitting a Pull Request

1. Fork the repo and create a feature branch from `main`
2. Make your changes
3. Run the full build to verify everything passes:
   ```bash
   npm run build
   ```
4. Open a pull request against `main` with:
   - A clear description of what changed and why
   - How you tested the changes (steps to reproduce / verify)
   - **Screenshots or GIFs for any UI changes**

## Reporting Bugs

[Open an issue](https://github.com/andywxy1/pixel-agents-app/issues) with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- OS version

## Feature Requests

Have an idea? [Open an issue](https://github.com/andywxy1/pixel-agents-app/issues) to discuss it before building. This helps avoid duplicate work and ensures the feature fits the project's direction.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.
