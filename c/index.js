const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const { hasHeader, updateHeader, insertHeader } = require('./header');
const { reflow } = require('./reflow');
const { minimalEdits, showTypeCheckingErrors } = require('../shared');

const SECTION = '42AIO.c';
const TAB_WIDTH = 4;
const TIMEOUT_MS = 30000;

/** @type {vscode.DiagnosticCollection} */
let diagnostics;
/** @type {vscode.OutputChannel} */
let output;
/** @type {vscode.StatusBarItem} */
let statusBar;
/** @type {vscode.TextEditorDecorationType} */
let inlineDecoration;
/** @type {ErrorsProvider} */
let errorsProvider;

const running = new Map(); // uri string -> { child, token }
let missingCommandWarned = false;

function config(resource) {
	return vscode.workspace.getConfiguration(SECTION, resource);
}

function isNormFile(doc) {
	return doc.uri.scheme === 'file' && /\.[ch]$/i.test(doc.uri.fsPath);
}

/** Splits the configured command into [bin, ...args]. */
function commandParts(resource) {
	const raw = (config(resource).get('command') || 'norminette').trim();
	return raw.split(/\s+/).filter(Boolean);
}

/**
 * Runs norminette and resolves to the parsed JSON report ({ files: [...] }).
 * Rejects with an Error whose `code` is 'ENOENT' when the command is missing.
 */
function runNorminette(parts, args, cwd, onChild) {
	return new Promise((resolve, reject) => {
		const [bin, ...base] = parts;
		const child = cp.spawn(bin, [...base, '-f', 'json', '--no-colors', ...args], { cwd });
		onChild?.(child);
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
			if (signal) {
				return reject(Object.assign(new Error('killed'), { killed: true }));
			}
			// norminette prints "Setting locale to ..." before the JSON; exit code 1 just means "norm errors".
			const start = stdout.indexOf('{');
			if (start === -1) {
				// norminette could not parse the source (e.g. an unfinished "#in" directive): it prints plain text.
				const message = (stdout || stderr)
					.replace(/\x1b\[[0-9;]*m/g, '')
					.split('\n')
					.map((l) => l.trim())
					.filter((l) => l && !/^Setting locale/.test(l) && !/: (Error|OK)!$/.test(l))
					.join(' ');
				return reject(Object.assign(new Error(message || `exit code ${code}`), { unparsable: true }));
			}
			try {
				resolve(JSON.parse(stdout.slice(start)));
			} catch (e) {
				reject(new Error(`Sortie illisible : ${e.message}\n${stdout}`));
			}
		});
	});
}

/** norminette columns are visual (1-based, tabs expand to 4): convert to a string index. */
function visualToIndex(text, column) {
	let visual = 0;
	for (let i = 0; i < text.length; i++) {
		if (visual >= column - 1) return i;
		visual = text[i] === '\t' ? visual + TAB_WIDTH - (visual % TAB_WIDTH) : visual + 1;
	}
	return text.length;
}

function highlightRange(doc, h) {
	const line = Math.min(Math.max((h.lineno || 1) - 1, 0), doc.lineCount - 1);
	const text = doc.lineAt(line).text;
	let start = visualToIndex(text, h.column || 1);
	let end;
	const firstNonWs = text.search(/\S/);
	if (h.length) {
		end = start + h.length;
	} else if (firstNonWs === -1 || start <= firstNonWs) {
		start = 0;
		end = text.trimEnd().length;
	} else {
		const m = /^(\w+|\s+|[^\w\s])/.exec(text.slice(start));
		end = start + (m ? m[0].length : 1);
	}
	return new vscode.Range(line, start, line, Math.min(end, text.length));
}

/** Turns a norminette file report into VS Code diagnostics for `doc`. */
function toDiagnostics(doc, report) {
	const cfg = config(doc.uri);
	const ignored = new Set((cfg.get('ignoredRules') || []).map((r) => String(r).toUpperCase()));
	const result = [];
	for (const err of report.errors || []) {
		if (ignored.has(String(err.name).toUpperCase())) continue;
		const severity =
			err.level === 'Notice' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
		const highlights = err.highlights && err.highlights.length ? err.highlights : [{ lineno: 1, column: 1 }];
		for (const h of highlights) {
			const d = new vscode.Diagnostic(highlightRange(doc, h), err.text, severity);
			d.code = err.name;
			d.source = 'norminette';
			result.push(d);
		}
	}
	result.sort(
		(a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character
	);
	return showTypeCheckingErrors(doc.uri) ? result : [];
}

function reportMissingCommand(resource, err) {
	output.appendLine(`Impossible de lancer la norminette : ${err.message}`);
	if (missingCommandWarned) return;
	missingCommandWarned = true;
	const cmd = commandParts(resource)[0];
	vscode.window
		.showErrorMessage(
			`42 All In One (C) : commande « ${cmd} » introuvable. Installe la norminette (pip install norminette) ou règle « 42AIO.c.command ».`,
			'Ouvrir les réglages'
		)
		.then((choice) => {
			if (choice) vscode.commands.executeCommand('workbench.action.openSettings', '42AIO.c.command');
		});
}

/** Diagnostic shown when norminette cannot parse the file; points at the offending "#directive" if the message names one. */
function parseFailureDiagnostic(doc, message) {
	let range = doc.lineAt(0).range;
	const token = /#\w+/.exec(message)?.[0];
	if (token) {
		const index = doc.getText().search(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b'));
		if (index !== -1) range = new vscode.Range(doc.positionAt(index), doc.positionAt(index + token.length));
	}
	const d = new vscode.Diagnostic(range, `La norminette n'a pas pu analyser le fichier : ${message}`, vscode.DiagnosticSeverity.Error);
	d.code = 'PARSE_ERROR';
	d.source = 'norminette';
	return d;
}

async function lintDocument(doc) {
	if (!isNormFile(doc)) return;
	if (!showTypeCheckingErrors(doc.uri)) {
		diagnostics.delete(doc.uri);
		return;
	}
	const key = doc.uri.toString();

	const previous = running.get(key);
	if (previous) previous.child?.kill();
	const token = Symbol();
	const entry = { child: null, token };
	running.set(key, entry);

	const flag = /\.h$/i.test(doc.uri.fsPath) ? '--hfile' : '--cfile';
	const args = [`${flag}=${doc.getText()}`, '--filename', path.basename(doc.uri.fsPath)];
	try {
		const report = await runNorminette(commandParts(doc.uri), args, path.dirname(doc.uri.fsPath), (c) => (entry.child = c));
		if (running.get(key)?.token !== token) return; // superseded by a newer run
		const file = (report.files || [])[0];
		diagnostics.set(doc.uri, file ? toDiagnostics(doc, file) : []);
	} catch (err) {
		if (err.killed) return;
		if (err.unparsable) {
			if (running.get(key)?.token === token) diagnostics.set(doc.uri, [parseFailureDiagnostic(doc, err.message)]);
			return;
		}
		if (err.code === 'ENOENT') return reportMissingCommand(doc.uri, err);
		output.appendLine(`[${doc.uri.fsPath}] ${err.message}`);
	} finally {
		if (running.get(key)?.token === token) running.delete(key);
	}
}

/** True when `dir` is inside a Git work tree (norminette's --use-gitignore fails anywhere else). */
function isGitRepo(dir) {
	return new Promise((resolve) => {
		cp.execFile('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { timeout: 5000 }, (err, stdout) =>
			resolve(!err && stdout.trim() === 'true')
		);
	});
}

async function checkWorkspace() {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || !folders.length) {
		vscode.window.showWarningMessage('Norminette : aucun dossier ouvert.');
		return;
	}
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, title: 'Norminette : analyse du workspace…' },
		async () => {
			const found = new Map(); // fsPath -> report
			for (const folder of folders) {
				const cfg = config(folder.uri);
				const useGitignore = cfg.get('useGitignore') && (await isGitRepo(folder.uri.fsPath));
				const args = useGitignore ? ['--use-gitignore', folder.uri.fsPath] : [folder.uri.fsPath];
				try {
					const report = await runNorminette(commandParts(folder.uri), args, folder.uri.fsPath);
					for (const f of report.files || []) found.set(f.path, f);
				} catch (err) {
					if (err.code === 'ENOENT') return reportMissingCommand(folder.uri, err);
					output.appendLine(`[${folder.uri.fsPath}] ${err.message}`);
					vscode.window.showErrorMessage(`Norminette : ${err.message.split('\n')[0]}`);
				}
			}
			diagnostics.clear();
			for (const [fsPath, report] of found) {
				if (!report.errors || !report.errors.length) continue;
				const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
				diagnostics.set(doc.uri, toDiagnostics(doc, report));
			}
		}
	);
}

/* ---------- auto-fix via c_formatter_42 ---------- */

/** Pipes `text` through c_formatter_42 (stdin -> stdout) and resolves to the formatted text. */
function runFormatter(resource, text) {
	return new Promise((resolve, reject) => {
		const raw = (config(resource).get('formatter.command') || 'c_formatter_42').trim();
		const [bin, ...base] = raw.split(/\s+/).filter(Boolean);
		const cwd = resource.scheme === 'file' ? path.dirname(resource.fsPath) : undefined;
		const child = cp.spawn(bin, base, { cwd });
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
		child.stdin.on('error', () => {}); // process may exit before reading everything
		child.stdin.end(text);
	});
}

/** Number of norminette errors in `text` (null if norminette could not run). */
async function countErrors(resource, text) {
	const flag = /\.h$/i.test(resource.fsPath) ? '--hfile' : '--cfile';
	const args = [`${flag}=${text}`, '--filename', path.basename(resource.fsPath)];
	try {
		const report = await runNorminette(commandParts(resource), args, path.dirname(resource.fsPath));
		return ((report.files || [])[0]?.errors || []).length;
	} catch {
		return null;
	}
}

/**
 * c_formatter_42, then a smarter re-wrap of long statements (break before ||, &&, comparisons...).
 * The re-wrapped version is kept only if norminette finds no more errors in it than in the plain formatter output.
 */
async function formatText(resource, text) {
	if (!text.trim()) return text;
	// c_formatter_42 skips declaration alignment when the file lacks its final newline; also drops blank lines at EOF.
	const formatted = await runFormatter(resource, text.replace(/\s+$/, '') + '\n');
	if (!formatted.trim() || !config(resource).get('smartWrap')) return formatted;
	const wrapped = reflow(formatted);
	if (wrapped === formatted) return formatted;
	const [before, after] = await Promise.all([countErrors(resource, formatted), countErrors(resource, wrapped)]);
	return before !== null && after !== null && after <= before ? wrapped : formatted;
}

/** Returns the edits that turn the document into its c_formatter_42 version ([] if unchanged or on failure). */
async function formatEdits(doc, { silent } = {}) {
	if (!isNormFile(doc)) return [];
	try {
		const formatted = await formatText(doc.uri, doc.getText());
		if (!formatted.trim()) return [];
		return minimalEdits(doc, formatted);
	} catch (err) {
		output.appendLine(`[format ${doc.uri.fsPath}] ${err.message}`);
		if (!silent) {
			const missing = err.code === 'ENOENT';
			vscode.window.showErrorMessage(
				missing
					? '42 All In One (C) : c_formatter_42 introuvable (pip install c_formatter_42) ou règle « 42AIO.c.formatter.command ».'
					: `42 All In One (C) : le formateur a échoué — ${err.message.split('\n')[0]}`
			);
		}
		return [];
	}
}

async function fixDocument(doc) {
	const edits = await formatEdits(doc);
	if (!edits.length) return;
	const we = new vscode.WorkspaceEdit();
	we.set(doc.uri, edits);
	await vscode.workspace.applyEdit(we);
}

/** .c/.h files of a workspace folder (Git-tracked and untracked-but-not-ignored when useGitignore applies). */
async function normFiles(folder) {
	const dir = folder.uri.fsPath;
	if (config(folder.uri).get('useGitignore') && (await isGitRepo(dir))) {
		const listed = await new Promise((resolve) => {
			cp.execFile(
				'git',
				['-C', dir, 'ls-files', '-co', '--exclude-standard', '-z', '--', '*.c', '*.h'],
				{ maxBuffer: 64 * 1024 * 1024 },
				(err, stdout) => resolve(err ? null : stdout.split('\0').filter(Boolean))
			);
		});
		if (listed) return listed.map((f) => vscode.Uri.file(path.join(dir, f))).filter((u) => fs.existsSync(u.fsPath));
	}
	return vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.{c,h}'), '**/{node_modules,.git}/**');
}

/** Runs c_formatter_42 on every .c/.h of the workspace, then re-checks it. */
async function fixWorkspace() {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || !folders.length) {
		vscode.window.showWarningMessage('Norminette : aucun dossier ouvert.');
		return;
	}
	const files = [];
	for (const folder of folders) files.push(...(await normFiles(folder)));
	if (!files.length) {
		vscode.window.showInformationMessage('42 All In One (C) : aucun fichier .c ou .h dans le workspace.');
		return;
	}
	const ok = await vscode.window.showWarningMessage(
		`Corriger la norme de ${files.length} fichier${files.length > 1 ? 's' : ''} .c/.h du workspace avec c_formatter_42 ?`,
		{ modal: true, detail: 'Les fichiers sont réécrits et sauvegardés (y compris ceux ouverts dans l\'éditeur).' },
		'Corriger'
	);
	if (ok !== 'Corriger') return;

	let changed = 0;
	const failed = [];
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Norminette : correction du workspace', cancellable: true },
		async (progress, cancel) => {
			for (const [i, uri] of files.entries()) {
				if (cancel.isCancellationRequested) break;
				progress.report({ message: `${i + 1}/${files.length} · ${path.basename(uri.fsPath)}`, increment: 100 / files.length });
				const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
				try {
					const text = open ? open.getText() : fs.readFileSync(uri.fsPath, 'utf8');
					const formatted = await formatText(uri, text);
					if (!formatted.trim() || formatted === text) continue;
					if (open) {
						const we = new vscode.WorkspaceEdit();
						we.set(uri, minimalEdits(open, formatted));
						await vscode.workspace.applyEdit(we);
						await open.save();
					} else {
						fs.writeFileSync(uri.fsPath, formatted);
					}
					changed++;
				} catch (err) {
					output.appendLine(`[fixWorkspace ${uri.fsPath}] ${err.message}`);
					if (err.code === 'ENOENT') {
						vscode.window.showErrorMessage(
							'42 All In One (C) : c_formatter_42 introuvable (pip install c_formatter_42) ou règle « 42AIO.c.formatter.command ».'
						);
						return;
					}
					failed.push(path.basename(uri.fsPath));
				}
			}
		}
	);
	const msg = `42 All In One (C) : ${changed} fichier${changed > 1 ? 's' : ''} corrigé${changed > 1 ? 's' : ''}.`;
	if (failed.length) {
		vscode.window.showWarningMessage(`${msg} Échec sur ${failed.length} (${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}) — voir la sortie « 42 All In One (C) ».`);
	} else {
		vscode.window.showInformationMessage(msg);
	}
	await checkWorkspace();
}

const fixActionProvider = {
	provideCodeActions(doc, _range, ctx) {
		if (!isNormFile(doc) || !ctx.diagnostics.some((d) => d.source === 'norminette')) return [];
		const action = new vscode.CodeAction('Norminette : corriger le fichier (c_formatter_42)', vscode.CodeActionKind.QuickFix);
		action.diagnostics = ctx.diagnostics.filter((d) => d.source === 'norminette');
		action.command = { command: '42AIO.c.fix', title: 'Corriger le fichier' };
		action.isPreferred = false;
		return [action];
	},
};

/* ---------- 42 header ---------- */

function headerInfo(doc) {
	const cfg = config(doc.uri);
	const user = (cfg.get('header.username') || '').trim() || process.env.USER || 'marvin';
	const email = (cfg.get('header.email') || '').trim() || `${user}@student.42.fr`;
	return { filename: path.basename(doc.uri.fsPath), user, email, date: new Date() };
}

const inserting = new Set();

/** Inserts a header when the file is empty or blank (new .c/.h file). */
async function insertHeaderIfEmpty(doc) {
	const key = doc.uri.toString();
	if (!isNormFile(doc) || doc.getText().trim() !== '' || inserting.has(key)) return;
	if (!config(doc.uri).get('header.autoInsert')) return;
	inserting.add(key);
	try {
		const we = new vscode.WorkspaceEdit();
		we.replace(doc.uri, doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0)), insertHeader('', headerInfo(doc)));
		await vscode.workspace.applyEdit(we);
	} finally {
		inserting.delete(key);
	}
}

/** Command: insert the header, or refresh it if the file already has one. */
async function headerCommand() {
	const doc = vscode.window.activeTextEditor?.document;
	if (!doc || !isNormFile(doc)) {
		vscode.window.showInformationMessage('42 All In One (C) : ouvre un fichier .c ou .h.');
		return;
	}
	const text = doc.getText();
	const info = headerInfo(doc);
	const next = hasHeader(text) ? updateHeader(text, info) : insertHeader(text, info);
	const we = new vscode.WorkspaceEdit();
	we.set(doc.uri, minimalEdits(doc, next));
	await vscode.workspace.applyEdit(we);
}

/** On open: add the header to an empty file, then run norminette on the result. */
async function onOpen(doc) {
	if (!isNormFile(doc)) return;
	await insertHeaderIfEmpty(doc);
	lintDocument(doc);
}

/** Edits applied just before a save: auto-fix (manual saves only), then header insertion (if missing) or "Updated" refresh. */
async function beforeSaveEdits(doc, reason) {
	if (!isNormFile(doc)) return [];
	const cfg = config(doc.uri);
	let text = doc.getText();
	if (cfg.get('autoFix') && reason === vscode.TextDocumentSaveReason.Manual) {
		try {
			const formatted = await formatText(doc.uri, text);
			if (formatted.trim()) text = formatted;
		} catch (err) {
			output.appendLine(`[autoFix ${doc.uri.fsPath}] ${err.message}`);
		}
	}
	if (!hasHeader(text)) {
		if (cfg.get('header.autoInsert')) text = insertHeader(text, headerInfo(doc));
	} else if (cfg.get('header.autoUpdate') && doc.isDirty) {
		text = updateHeader(text, headerInfo(doc));
	}
	return minimalEdits(doc, text);
}

/* ---------- inline messages ---------- */

function updateInline(editor) {
	if (!editor) return;
	const doc = editor.document;
	if (!isNormFile(doc) || !config(doc.uri).get('inlineErrors')) {
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
			renderOptions: { after: { contentText: `  ${list[0].message}${extra}` } },
		});
	}
	editor.setDecorations(inlineDecoration, options);
}

/* ---------- status bar ---------- */

function updateStatusBar() {
	const editor = vscode.window.activeTextEditor;
	if (!editor || !isNormFile(editor.document)) {
		statusBar.hide();
		return;
	}
	const list = diagnostics.get(editor.document.uri) || [];
	if (list.length) {
		statusBar.text = `$(error) Norm : ${list.length}`;
		statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
		statusBar.tooltip = 'Erreurs de norme dans ce fichier, cliquer pour ouvrir le panneau';
	} else {
		statusBar.text = '$(check) Norm OK';
		statusBar.backgroundColor = undefined;
		statusBar.tooltip = 'Aucune erreur de norme dans ce fichier';
	}
	statusBar.show();
}

/* ---------- side panel ---------- */

class ErrorsProvider {
	constructor() {
		this._emitter = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._emitter.event;
	}

	refresh() {
		this._emitter.fire();
	}

	getTreeItem(element) {
		return element;
	}

	getChildren(element) {
		if (element) return element.children || [];
		const files = [];
		diagnostics.forEach((uri, list) => {
			if (!list.length) return;
			const item = new vscode.TreeItem(path.basename(uri.fsPath));
			item.description = `${vscode.workspace.asRelativePath(path.dirname(uri.fsPath), false)} · ${list.length}`;
			item.resourceUri = uri;
			item.iconPath = vscode.ThemeIcon.File;
			item.contextValue = 'file';
			item.children = list.map((d) => {
				const e = new vscode.TreeItem(d.message);
				e.description = `${d.code} · L${d.range.start.line + 1}`;
				e.tooltip = `${d.code}\n${d.message}`;
				e.iconPath = new vscode.ThemeIcon(
					d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
					new vscode.ThemeColor(d.severity === vscode.DiagnosticSeverity.Error ? 'editorError.foreground' : 'editorWarning.foreground')
				);
				e.command = { command: 'vscode.open', title: 'Ouvrir', arguments: [uri, { selection: d.range }] };
				return e;
			});
			item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
			files.push(item);
		});
		files.sort((a, b) => a.resourceUri.fsPath.localeCompare(b.resourceUri.fsPath));
		if (files.length > 3) files.forEach((f) => (f.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed));
		return files;
	}
}

/* ---------- activation ---------- */

function activate(context) {
	diagnostics = vscode.languages.createDiagnosticCollection('norminette');
	output = vscode.window.createOutputChannel('42 All In One (C)');
	statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBar.command = 'workbench.view.extension.norminette';
	inlineDecoration = vscode.window.createTextEditorDecorationType({
		after: { color: new vscode.ThemeColor('editorError.foreground'), fontStyle: 'italic', margin: '0 0 0 1em' },
	});
	errorsProvider = new ErrorsProvider();

	context.subscriptions.push(
		diagnostics,
		output,
		statusBar,
		inlineDecoration,
		vscode.window.createTreeView('42AIO.c.errors', { treeDataProvider: errorsProvider }),

		vscode.commands.registerCommand('42AIO.c.checkFile', () => {
			const doc = vscode.window.activeTextEditor?.document;
			if (doc && isNormFile(doc)) return lintDocument(doc);
			vscode.window.showInformationMessage('Norminette : ouvre un fichier .c ou .h.');
		}),
		vscode.commands.registerCommand('42AIO.c.fix', () => {
			const doc = vscode.window.activeTextEditor?.document;
			if (doc && isNormFile(doc)) return fixDocument(doc);
			vscode.window.showInformationMessage('Norminette : ouvre un fichier .c ou .h.');
		}),
		vscode.languages.registerDocumentFormattingEditProvider(
			[{ language: 'c', scheme: 'file' }, { language: 'cpp', scheme: 'file' }],
			{ provideDocumentFormattingEdits: (doc) => formatEdits(doc) }
		),
		vscode.languages.registerCodeActionsProvider(
			[{ language: 'c', scheme: 'file' }, { language: 'cpp', scheme: 'file' }],
			fixActionProvider,
			{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
		),
		vscode.workspace.onWillSaveTextDocument((e) => {
			if (isNormFile(e.document)) e.waitUntil(beforeSaveEdits(e.document, e.reason));
		}),
		vscode.commands.registerCommand('42AIO.c.insertHeader', headerCommand),
		vscode.commands.registerCommand('42AIO.c.checkWorkspace', checkWorkspace),
		vscode.commands.registerCommand('42AIO.c.fixWorkspace', fixWorkspace),

		vscode.workspace.onDidOpenTextDocument(onOpen),
		// norminette runs on open and on save
		vscode.workspace.onDidSaveTextDocument((doc) => {
			if (isNormFile(doc)) lintDocument(doc);
		}),
		vscode.workspace.onDidCloseTextDocument((doc) => {
			const key = doc.uri.toString();
			running.get(key)?.child?.kill();
			running.delete(key);
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration(SECTION)) return;
			missingCommandWarned = false;
			vscode.window.visibleTextEditors.forEach(updateInline);
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('42AIO.showTypeCheckingErrors')) vscode.workspace.textDocuments.forEach(lintDocument);
		}),

		vscode.languages.onDidChangeDiagnostics(() => {
			vscode.window.visibleTextEditors.forEach(updateInline);
			updateStatusBar();
			errorsProvider.refresh();
		}),
		vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar()),
		vscode.window.onDidChangeVisibleTextEditors((eds) => eds.forEach(updateInline))
	);

	vscode.workspace.textDocuments.forEach(onOpen);
	updateStatusBar();
}

function deactivate() {
	for (const { child } of running.values()) child?.kill();
}

module.exports = { activate, deactivate };
