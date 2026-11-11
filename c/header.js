const WIDTH = 80;
const MARGIN = 5;
const ASCII = [
	'        :::      ::::::::',
	'      :+:      :+:    :+:',
	'    +:+ +:+         +:+  ',
	'  +#+  +:+       +#+     ',
	'+#+#+#+#+#+   +#+        ',
	'     #+#    #+#          ',
	'    ###   ########.fr    ',
];
const TOP = '/* ' + '*'.repeat(WIDTH - 6) + ' */';

function textLine(left, right = '') {
	const room = WIDTH - MARGIN * 2 - right.length;
	const l = left.slice(0, room);
	const gap = ' '.repeat(MARGIN - 2);
	return '/*' + gap + l + ' '.repeat(room - l.length) + right + gap + '*/';
}

const pad = (n) => String(n).padStart(2, '0');

function formatDate(d) {
	return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The 11 lines of a standard 42 header. */
function buildHeader({ filename, user, email, date }) {
	const stamp = formatDate(date);
	return [
		TOP,
		textLine(''),
		textLine('', ASCII[0]),
		textLine(filename, ASCII[1]),
		textLine('', ASCII[2]),
		textLine(`By: ${user} <${email}>`, ASCII[3]),
		textLine('', ASCII[4]),
		textLine(`Created: ${stamp} by ${user}`, ASCII[5]),
		textLine(`Updated: ${stamp} by ${user}`, ASCII[6]),
		textLine(''),
		TOP,
	];
}

function hasHeader(text) {
	const lines = text.split('\n', 11);
	return (
		lines.length === 11 &&
		lines[0] === TOP &&
		lines[10] === TOP &&
		/^\/\*   By: /.test(lines[5]) &&
		/^\/\*   Created: /.test(lines[7]) &&
		/^\/\*   Updated: /.test(lines[8])
	);
}

/** Refreshes the filename and "Updated" lines of an existing header; returns the text unchanged if there is none. */
function updateHeader(text, { filename, user, date }) {
	if (!hasHeader(text)) return text;
	const lines = text.split('\n');
	lines[3] = textLine(filename, ASCII[1]);
	lines[8] = textLine(`Updated: ${formatDate(date)} by ${user}`, ASCII[6]);
	return lines.join('\n');
}

/** Prepends a fresh header (followed by a blank line) to `text`. */
function insertHeader(text, info) {
	return buildHeader(info).join('\n') + '\n\n' + text;
}

module.exports = { buildHeader, hasHeader, updateHeader, insertHeader, formatDate };
