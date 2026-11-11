const vscode = require('vscode');
const black = require('./black');
const flake8 = require('./flake8');

function activate(context) {
	const output = vscode.window.createOutputChannel('42 All In One (Python)');
	context.subscriptions.push(output);
	black.activate(context, output);
	flake8.activate(context, output);
}

function deactivate() {
	flake8.deactivate();
}

module.exports = { activate, deactivate };
