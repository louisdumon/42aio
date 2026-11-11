const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const { minimalEdits } = require('../shared');

const SECTION = '42AIO.python';
const TIMEOUT_MS = 30000;

/** @type {vscode.OutputChannel} */
let output;
let missingWarned = false;

const config = (resource) => vscode.workspace.getConfiguration(SECTION, resource);
const isPython = (doc) => doc.uri.scheme === 'file' && doc.languageId === 'python';

/** Pipes `text` through black (stdin -> stdout). --stdin-filename lets black pick up the project's pyproject.toml. */
function runBlack(doc, text) {
	return new Promise((resolve, reject) => {
		const cfg = config(doc.uri);
		const [bin, ...base] = (cfg.get('black.command') || 'black').trim().split(/\s+/).filter(Boolean);
		const extra = cfg.get('black.args') || [];
		const args = [...base, ...extra, '--quiet', '--stdin-filename', doc.uri.fsPath, '-'];
		const child = cp.spawn(bin, args, { cwd: path.dirname(doc.uri.fsPath) });
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
		child.stdout.on('data', (d) => (stdout += d));
		child.stderr.on('data', (d) => (stderr += d));
		child.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			if (code !== 0) return reject(new Error((stderr || `exit code ${code}`).trim()));
			resolve(stdout);
		});
		child.stdin.on('error', () => {}); // black may exit before reading everything (syntax error)
		child.stdin.end(text);
	});
}

/** Edits that turn the document into its black-formatted version ([] if unchanged or on failure). */
async function formatEdits(doc, { silent } = {}) {
	if (!isPython(doc)) return [];
	try {
		const formatted = await runBlack(doc, doc.getText());
		if (!formatted.trim()) return [];
		return minimalEdits(doc, formatted);
	} catch (err) {
		output.appendLine(`[black ${doc.uri.fsPath}] ${err.message}`);
		if (!silent) reportBlackError(err);
		return [];
	}
}

function reportBlackError(err) {
	if (err.code === 'ENOENT') {
		if (missingWarned) return;
		missingWarned = true;
		vscode.window
			.showErrorMessage('42 All In One (Python) : black introuvable (pip install black) ou règle « 42AIO.python.black.command ».', 'Ouvrir les réglages')
			.then((choice) => choice && vscode.commands.executeCommand('workbench.action.openSettings', '42AIO.python.black.command'));
	} else {
		vscode.window.showErrorMessage(`42 All In One (Python) : black a échoué — ${err.message.split('\n')[0]}`);
	}
}

async function formatDocument(doc) {
	const edits = await formatEdits(doc);
	if (!edits.length) return;
	const we = new vscode.WorkspaceEdit();
	we.set(doc.uri, edits);
	await vscode.workspace.applyEdit(we);
}

function activate(context, outputChannel) {
	output = outputChannel;
	context.subscriptions.push(
		vscode.commands.registerCommand('42AIO.python.format', () => {
			const doc = vscode.window.activeTextEditor?.document;
			if (doc && isPython(doc)) return formatDocument(doc);
			vscode.window.showInformationMessage('42 All In One (Python) : ouvre un fichier Python.');
		}),
		vscode.languages.registerDocumentFormattingEditProvider(
			{ language: 'python', scheme: 'file' },
			{ provideDocumentFormattingEdits: (doc) => formatEdits(doc) }
		),
		vscode.workspace.onWillSaveTextDocument((e) => {
			if (
				e.reason === vscode.TextDocumentSaveReason.Manual &&
				isPython(e.document) &&
				config(e.document.uri).get('formatOnSave')
			) {
				e.waitUntil(formatEdits(e.document, { silent: true }));
			}
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(SECTION)) missingWarned = false;
		})
	);
}

module.exports = { activate };
