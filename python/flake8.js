const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const { errorLensInstalled, showTypeCheckingErrors } = require('../shared');

const SECTION = '42AIO.python';
const TIMEOUT_MS = 30000;
const FORMAT = '%(row)d:%(col)d:%(code)s:%(text)s';
const LINE_RE = /^(\d+):(\d+):(\w+):(.*)$/;

/** @type {vscode.DiagnosticCollection} */
let diagnostics;
/** @type {vscode.OutputChannel} */
let output;
/** @type {vscode.TextEditorDecorationType} */
let inlineDecoration;

const running = new Map(); // uri string -> { child, token }
let missingWarned = false;

const config = (resource) => vscode.workspace.getConfiguration(SECTION, resource);
const isPython = (doc) => doc.uri.scheme === 'file' && doc.languageId === 'python';

/** Runs flake8 on `text` (stdin) and resolves to its stdout. Exit code 1 only means "violations found". */
function runFlake8(doc, onChild) {
	return new Promise((resolve, reject) => {
		const cfg = config(doc.uri);
		const [bin, ...base] = (cfg.get('flake8.command') || 'flake8').trim().split(/\s+/).filter(Boolean);
		const extra = cfg.get('flake8.args') || [];
		const args = [...base, ...extra, '--format', FORMAT, '--stdin-display-name', doc.uri.fsPath, '-'];
		const child = cp.spawn(bin, args, { cwd: path.dirname(doc.uri.fsPath) });
		onChild(child);
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
		child.stdout.on('data', (d) => (stdout += d));
		child.stderr.on('data', (d) => (stderr += d));
		child.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on('close', (code, signal) => {
			clearTimeout(timer);
			if (signal) return reject(Object.assign(new Error('killed'), { killed: true }));
			if (code !== 0 && code !== 1) return reject(new Error((stderr || `exit code ${code}`).trim()));
			resolve(stdout);
		});
		child.stdin.on('error', () => {});
		child.stdin.end(doc.getText());
	});
}

function toDiagnostic(doc, row, col, code, text) {
	const line = Math.min(Math.max(row - 1, 0), doc.lineCount - 1);
	const lineText = doc.lineAt(line).text;
	const start = Math.min(Math.max(col - 1, 0), lineText.length);
	let end;
	if (code === 'E501') {
		end = lineText.length; // line too long: underline the overflow
	} else {
		const m = /^(\w+|\s+|[^\w\s])/.exec(lineText.slice(start));
		end = start + (m ? m[0].length : 1);
	}
	const severity = code.startsWith('W') ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
	const d = new vscode.Diagnostic(new vscode.Range(line, start, line, end), text.trim(), severity);
	d.code = code;
	d.source = 'flake8';
	return d;
}

async function lintDocument(doc) {
	if (!isPython(doc) || !config(doc.uri).get('flake8.enabled')) return;
	if (!showTypeCheckingErrors(doc.uri)) {
		diagnostics.delete(doc.uri);
		return;
	}
	const key = doc.uri.toString();
	running.get(key)?.child?.kill();
	const token = Symbol();
	const entry = { child: null, token };
	running.set(key, entry);
	try {
		const stdout = await runFlake8(doc, (c) => (entry.child = c));
		if (running.get(key)?.token !== token) return;
		const list = [];
		for (const line of stdout.split('\n')) {
			const m = LINE_RE.exec(line);
			if (m) list.push(toDiagnostic(doc, Number(m[1]), Number(m[2]), m[3], m[4]));
		}
		diagnostics.set(doc.uri, list);
	} catch (err) {
		if (err.killed) return;
		output.appendLine(`[flake8 ${doc.uri.fsPath}] ${err.message}`);
		if (err.code === 'ENOENT' && !missingWarned) {
			missingWarned = true;
			vscode.window
				.showErrorMessage('42 All In One (Python) : flake8 introuvable (pip install flake8) ou règle « 42AIO.python.flake8.command ».', 'Ouvrir les réglages')
				.then((choice) => choice && vscode.commands.executeCommand('workbench.action.openSettings', '42AIO.python.flake8.command'));
		}
	} finally {
		if (running.get(key)?.token === token) running.delete(key);
	}
}

/* ---------- inline messages ---------- */

function updateInline(editor) {
	const doc = editor.document;
	if (!isPython(doc) || !config(doc.uri).get('inlineErrors') || errorLensInstalled()) {
		editor.setDecorations(inlineDecoration, []);
		return;
	}
	const byLine = new Map();
	for (const d of diagnostics.get(doc.uri) || []) {
		const line = d.range.start.line;
		if (line >= doc.lineCount) continue;
		if (!byLine.has(line)) byLine.set(line, []);
		byLine.get(line).push(d);
	}
	const options = [];
	for (const [line, list] of byLine) {
		const extra = list.length > 1 ? `  (+${list.length - 1})` : '';
		options.push({
			range: doc.lineAt(line).range,
			renderOptions: { after: { contentText: `  ${list[0].code} ${list[0].message}${extra}` } },
		});
	}
	editor.setDecorations(inlineDecoration, options);
}

function activate(context, outputChannel) {
	output = outputChannel;
	diagnostics = vscode.languages.createDiagnosticCollection('flake8');
	inlineDecoration = vscode.window.createTextEditorDecorationType({
		after: { color: new vscode.ThemeColor('editorError.foreground'), fontStyle: 'italic', margin: '0 0 0 1em' },
	});

	context.subscriptions.push(
		diagnostics,
		inlineDecoration,
		vscode.commands.registerCommand('42AIO.python.check', () => {
			const doc = vscode.window.activeTextEditor?.document;
			if (doc && isPython(doc)) return lintDocument(doc);
			vscode.window.showInformationMessage('42 All In One (Python) : ouvre un fichier Python.');
		}),
		// flake8 runs on open and on save
		vscode.workspace.onDidOpenTextDocument(lintDocument),
		vscode.workspace.onDidSaveTextDocument(lintDocument),
		vscode.workspace.onDidCloseTextDocument((doc) => {
			const key = doc.uri.toString();
			running.get(key)?.child?.kill();
			running.delete(key);
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration(SECTION) && !e.affectsConfiguration('42AIO.showTypeCheckingErrors')) return;
			missingWarned = false;
			if (!e.affectsConfiguration(`${SECTION}.flake8.enabled`) && !e.affectsConfiguration('42AIO.showTypeCheckingErrors')) {
				vscode.window.visibleTextEditors.forEach(updateInline);
				return;
			}
			if (config().get('flake8.enabled') && showTypeCheckingErrors()) vscode.workspace.textDocuments.forEach(lintDocument);
			else diagnostics.clear();
		}),
		vscode.languages.onDidChangeDiagnostics(() => vscode.window.visibleTextEditors.forEach(updateInline)),
		vscode.window.onDidChangeVisibleTextEditors((eds) => eds.forEach(updateInline))
	);
	vscode.workspace.textDocuments.forEach(lintDocument);
}

function deactivate() {
	for (const { child } of running.values()) child?.kill();
}

module.exports = { activate, deactivate };
