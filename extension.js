const c = require('./c');
const python = require('./python');
const settings = require('./settings');

function activate(context) {
	c.activate(context);
	python.activate(context);
	settings.activate(context);
}

function deactivate() {
	c.deactivate();
	python.deactivate();
}

module.exports = { activate, deactivate };
