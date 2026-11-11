const c = require('./c');
const python = require('./python');

function activate(context) {
	c.activate(context);
	python.activate(context);
}

function deactivate() {
	c.deactivate();
	python.deactivate();
}

module.exports = { activate, deactivate };
