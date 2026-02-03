const vscode = require('vscode');
const path = require('path');

/** @type {Map<string, number>} uri → last known mtime */
const mtimeCache = new Map();
let reloading = false;
/** @type {Set<string>} */
const recentlyReloaded = new Set();
/** @type {NodeJS.Timeout | null} */
let pollTimer = null;
/** @type {vscode.OutputChannel} */
let output;

function activate(context) {
    output = vscode.window.createOutputChannel('Notebook Hot Reload');
    output.appendLine('Notebook Hot Reload activated');

    startPolling();

    // Restart polling when settings change
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('notebookHotReload')) {
                stopPolling();
                startPolling();
            }
        })
    );

    context.subscriptions.push(
        { dispose: () => stopPolling() },
        output
    );
}

function getConfig() {
    const cfg = vscode.workspace.getConfiguration('notebookHotReload');
    return {
        enabled: cfg.get('enabled', true),
        interval: cfg.get('pollingInterval', 1500),
    };
}

function startPolling() {
    const { enabled, interval } = getConfig();
    if (!enabled) {
        output.appendLine('Hot reload is disabled via settings.');
        return;
    }
    pollTimer = setInterval(() => pollNotebooks(), interval);
    output.appendLine(`Polling every ${interval}ms for .ipynb changes...`);
}

function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

async function pollNotebooks() {
    if (reloading) return;

    for (const notebook of vscode.workspace.notebookDocuments) {
        const uri = notebook.uri;
        if (!uri.fsPath.endsWith('.ipynb')) continue;

        const key = uri.toString();
        if (recentlyReloaded.has(key)) continue;

        try {
            const stat = await vscode.workspace.fs.stat(uri);
            const mtime = stat.mtime;
            const prevMtime = mtimeCache.get(key);

            if (prevMtime === undefined) {
                mtimeCache.set(key, mtime);
                continue;
            }

            if (mtime !== prevMtime) {
                mtimeCache.set(key, mtime);
                await reloadNotebook(notebook, uri, key);
            }
        } catch (_) {}
    }
}

/**
 * Compare an existing cell in the notebook with new cell data.
 */
function cellsMatch(oldCell, newCellData) {
    if (oldCell.kind !== newCellData.kind) return false;
    if (oldCell.document.getText() !== newCellData.value) return false;
    if ((oldCell.executionSummary?.executionOrder || 0) !== (newCellData.executionSummary?.executionOrder || 0)) return false;
    if ((oldCell.outputs?.length || 0) !== (newCellData.outputs?.length || 0)) return false;
    return true;
}

async function reloadNotebook(notebook, uri, key) {
    reloading = true;
    recentlyReloaded.add(key);

    try {
        const content = await vscode.workspace.fs.readFile(uri);
        const json = JSON.parse(Buffer.from(content).toString('utf8'));

        if (!json.cells || !Array.isArray(json.cells)) return;

        const lang = json.metadata?.kernelspec?.language || 'python';
        const newCells = json.cells.map(cell => buildCellData(cell, lang));

        const oldCount = notebook.cellCount;
        const newCount = newCells.length;

        // Find first differing cell from the start
        let start = 0;
        while (start < Math.min(oldCount, newCount) && cellsMatch(notebook.cellAt(start), newCells[start])) {
            start++;
        }

        // Find first differing cell from the end
        let oldEnd = oldCount;
        let newEnd = newCount;
        while (oldEnd > start && newEnd > start && cellsMatch(notebook.cellAt(oldEnd - 1), newCells[newEnd - 1])) {
            oldEnd--;
            newEnd--;
        }

        if (start === oldEnd && start === newEnd) return; // No changes

        const edit = new vscode.WorkspaceEdit();
        edit.set(uri, [
            vscode.NotebookEdit.replaceCells(
                new vscode.NotebookRange(start, oldEnd),
                newCells.slice(start, newEnd)
            )
        ]);

        const success = await vscode.workspace.applyEdit(edit);
        output.appendLine(`${path.basename(uri.fsPath)}: replaced cells [${start}..${oldEnd}) → ${newEnd - start} cells (${success ? 'ok' : 'FAIL'})`);

    } catch (err) {
        output.appendLine(`Error: ${err.message}`);
    } finally {
        reloading = false;
        setTimeout(() => recentlyReloaded.delete(key), 3000);
    }
}

function buildCellData(cell, lang) {
    const kind = cell.cell_type === 'code'
        ? vscode.NotebookCellKind.Code
        : vscode.NotebookCellKind.Markup;
    const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
    const language = cell.cell_type === 'code' ? lang : 'markdown';
    const cellData = new vscode.NotebookCellData(kind, source, language);

    if (cell.outputs && Array.isArray(cell.outputs)) {
        cellData.outputs = cell.outputs.map(convertOutput).filter(Boolean);
    }
    if (cell.execution_count != null) {
        cellData.executionSummary = { executionOrder: cell.execution_count };
    }
    return cellData;
}

function convertOutput(out) {
    const items = [];

    if (out.output_type === 'stream') {
        const text = Array.isArray(out.text) ? out.text.join('') : (out.text || '');
        items.push(vscode.NotebookCellOutputItem.text(text, 'text/plain'));
    } else if (out.output_type === 'execute_result' || out.output_type === 'display_data') {
        if (out.data) {
            for (const [mime, data] of Object.entries(out.data)) {
                const content = Array.isArray(data) ? data.join('') : String(data);
                if (mime.startsWith('image/')) {
                    items.push(new vscode.NotebookCellOutputItem(Buffer.from(content, 'base64'), mime));
                } else {
                    items.push(vscode.NotebookCellOutputItem.text(content, mime));
                }
            }
        }
    } else if (out.output_type === 'error') {
        const traceback = (out.traceback || []).join('\n');
        items.push(vscode.NotebookCellOutputItem.error(
            new Error(`${out.ename}: ${out.evalue}\n${traceback}`)
        ));
    }

    if (items.length === 0) return null;
    return new vscode.NotebookCellOutput(items);
}

function deactivate() {
    stopPolling();
}

module.exports = { activate, deactivate };
