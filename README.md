# Notebook Hot Reload

Auto-reload Jupyter notebooks in VS Code when `.ipynb` files are modified externally.

## Why I Built This

I use [Claude Code](https://claude.ai/claude-code) with a [Jupyter MCP server](https://github.com/datalayer/jupyter-mcp-server) to have an AI agent write and execute notebook cells for me. The problem: **VS Code's notebook editor never reflects external changes**. Every time Claude added a cell or ran code, I had to switch tabs and come back to see the result.

I investigated why VS Code Copilot doesn't have this problem. The answer: Copilot is a VS Code extension with direct access to the internal `NotebookEdit` API. External tools like Claude Code, Cursor agents, or MCP servers can only write to the `.ipynb` file on disk — and VS Code's notebook editor ignores disk changes for already-open notebooks. `File: Revert File` doesn't work either; it's a no-op when the notebook isn't dirty.

The only thing that triggers a reload is switching away from the notebook tab and coming back. That's because VS Code checks the file's mtime when the editor regains focus. But there's no API to trigger this programmatically.

So I built this extension. It polls the mtime of open `.ipynb` files and, when a change is detected, reads the file from disk and applies a diff using `NotebookEdit.replaceCells()` — the same API that Copilot uses internally. Only changed cells are replaced, so your scroll position is preserved.

This was also necessary because my HPC cluster uses GPFS, where `inotify` events don't propagate, making `vscode.workspace.createFileSystemWatcher` useless. Polling is the only reliable approach.

## Features

- Polls open notebooks for disk changes (configurable interval)
- Diff-based updates — only modified/added/removed cells are touched
- Scroll position preserved — unchanged cells are not replaced
- Handles code cells, markdown cells, outputs (text, images, errors), and execution counts
- Works on any filesystem (no `inotify` dependency)
- Works with Remote-SSH, WSL, and containers

## Install

Search **"Notebook Hot Reload"** in VS Code Extensions, or:

```
ext install kdkyum.notebook-hot-reload
```

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `notebookHotReload.enabled` | `true` | Enable/disable hot reload |
| `notebookHotReload.pollingInterval` | `1500` | Polling interval in ms (500-10000) |

## How It Works

1. When a Jupyter notebook is open, the extension polls the file's modification time every 1.5s
2. When a change is detected, it reads the `.ipynb` JSON from disk
3. It diffs the current in-memory cells against the new cells (comparing source, kind, execution count, output count)
4. Only the changed range is replaced via `WorkspaceEdit` + `NotebookEdit.replaceCells()`
5. Unchanged cells before and after the edit are left untouched (preserving scroll position)

## Use Cases

- **Claude Code + Jupyter MCP**: See notebook changes in real-time as an AI agent edits and executes cells
- **Cursor / Windsurf + MCP**: External agent modifications appear instantly in VS Code
- **HPC / Remote-SSH**: Works on parallel filesystems (GPFS, NFS, Lustre) where `inotify` is unavailable
- **Scripts & automation**: Any workflow where notebooks are modified outside VS Code

## License

MIT
