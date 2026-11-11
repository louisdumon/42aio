const vscode = require('vscode');

/** Each toggle drives one or more boolean settings: checked when all of them are true. */
const TOGGLES = [
	{
		id: 'errors',
		label: 'Afficher les erreurs de norme',
		tooltip: 'Norminette (C) et flake8 (Python)',
		keys: ['42AIO.showTypeCheckingErrors'],
	},
	{
		id: 'format',
		label: 'Formatage automatique à la sauvegarde',
		tooltip: 'c_formatter_42 (C) et Black (Python)',
		keys: ['42AIO.c.autoFix', '42AIO.python.formatOnSave'],
	},
];

/** Plain clickable rows shown under the toggles. */
const ACTIONS = [
	{ id: 'checkWorkspace', label: 'Vérifier le workspace', tooltip: 'Lancer la norminette sur tout le workspace', icon: 'search', command: '42AIO.c.checkWorkspace' },
	{ id: 'fixWorkspace', label: 'Corriger le workspace', tooltip: 'Corriger la norme de tous les .c/.h avec c_formatter_42', icon: 'wand', command: '42AIO.c.fixWorkspace' },
];

function split(key) {
	const i = key.lastIndexOf('.');
	return [key.slice(0, i), key.slice(i + 1)];
}

function isOn(key) {
	const [section, name] = split(key);
	return vscode.workspace.getConfiguration(section).get(name, true) === true;
}

/** Writes at the most specific level that already defines the setting, so the change actually takes effect. */
async function setValue(key, value) {
	const [section, name] = split(key);
	const cfg = vscode.workspace.getConfiguration(section);
	const info = cfg.inspect(name) || {};
	let target = vscode.ConfigurationTarget.Global;
	if (info.workspaceFolderValue !== undefined) target = vscode.ConfigurationTarget.WorkspaceFolder;
	else if (info.workspaceValue !== undefined) target = vscode.ConfigurationTarget.Workspace;
	await cfg.update(name, value, target);
}

class SettingsProvider {
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
		if (element) return [];
		const toggles = TOGGLES.map((t) => {
			const item = new vscode.TreeItem(t.label);
			item.id = t.id;
			item.tooltip = t.tooltip;
			item.checkboxState = t.keys.every(isOn)
				? vscode.TreeItemCheckboxState.Checked
				: vscode.TreeItemCheckboxState.Unchecked;
			return item;
		});
		const actions = ACTIONS.map((a) => {
			const item = new vscode.TreeItem(a.label);
			item.id = a.id;
			item.tooltip = a.tooltip;
			item.iconPath = new vscode.ThemeIcon(a.icon);
			item.command = { command: a.command, title: a.label };
			return item;
		});
		return [...toggles, ...actions];
	}
}

function activate(context) {
	const provider = new SettingsProvider();
	const view = vscode.window.createTreeView('42AIO.settings', { treeDataProvider: provider });

	context.subscriptions.push(
		view,
		view.onDidChangeCheckboxState(async (e) => {
			for (const [item, state] of e.items) {
				const toggle = TOGGLES.find((t) => t.id === item.id);
				if (!toggle) continue;
				const value = state === vscode.TreeItemCheckboxState.Checked;
				for (const key of toggle.keys) await setValue(key, value);
			}
			provider.refresh();
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (TOGGLES.some((t) => t.keys.some((k) => e.affectsConfiguration(k)))) provider.refresh();
		})
	);
}

module.exports = { activate };
