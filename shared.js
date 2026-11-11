const vscode = require('vscode');

/** One edit replacing only the span that differs between the document and `newText` (keeps cursors stable). */
function minimalEdits(doc, newText) {
	const oldText = doc.getText();
	if (newText === oldText) return [];
	let start = 0;
	const max = Math.min(oldText.length, newText.length);
	while (start < max && oldText[start] === newText[start]) start++;
	let endOld = oldText.length;
	let endNew = newText.length;
	while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
		endOld--;
		endNew--;
	}
	return [vscode.TextEdit.replace(new vscode.Range(doc.positionAt(start), doc.positionAt(endOld)), newText.slice(start, endNew))];
}

/** Error Lens already renders every diagnostic inline; drawing our own would show each message twice. */
function errorLensInstalled() {
	return !!vscode.extensions.getExtension('usernamehw.errorlens');
}

/** Global "Show type checking errors" toggle (norminette and flake8). */
function showTypeCheckingErrors(resource) {
	return vscode.workspace.getConfiguration('42AIO', resource).get('showTypeCheckingErrors', true);
}

module.exports = { minimalEdits, errorLensInstalled, showTypeCheckingErrors };
