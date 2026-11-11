/**
 * Re-wraps long statements at logical boundaries (||, &&, comparisons, =, arithmetic, commas)
 * instead of wherever the formatter happened to run out of room.
 * Pure text in / text out: no VS Code dependency.
 */

const TAB = 4;
const TOKEN_RE =
	/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\w+|<<=|>>=|&&|\|\||==|!=|<=|>=|<<|>>|->|\+\+|--|[+\-*\/%&|^]=|[^\s\w]/g;

// Lower rank = lower precedence = better place to break. Operators start the new line (the norm forbids
// them at end of line), commas end it. `=` is never a break point.
const RANK = {
	',': 0,
	'||': 2,
	'&&': 3,
	'|': 4,
	'^': 4,
	'&': 4,
	'==': 5,
	'!=': 5,
	'<': 5,
	'>': 5,
	'<=': 5,
	'>=': 5,
	'<<': 6,
	'>>': 6,
	'+': 7,
	'-': 7,
	'*': 8,
	'/': 8,
	'%': 8,
};
const OPERAND_END = /^(?:\w|"|'|\)|\]).*$/s;

function visualWidth(s) {
	let w = 0;
	for (const c of s) w = c === '\t' ? w + TAB - (w % TAB) : w + 1;
	return w;
}

const indentOf = (line) => /^[ \t]*/.exec(line)[0];

function tokenize(str) {
	const tokens = [];
	let depth = 0;
	for (const m of str.matchAll(TOKEN_RE)) {
		const text = m[0];
		if (text === ')' || text === ']') depth--;
		tokens.push({ text, start: m.index, end: m.index + text.length, depth });
		if (text === '(' || text === '[') depth++;
	}
	return tokens;
}

/** Break points of `str`: { pos, rank, depth } where `pos` is the index the new line starts at. */
function candidates(str) {
	const tokens = tokenize(str);
	const out = [];
	tokens.forEach((t, i) => {
		const prev = tokens[i - 1];
		const next = tokens[i + 1];
		if (t.text === ',') {
			out.push({ pos: t.end, rank: 0, depth: t.depth });
		} else if (t.text in RANK) {
			const binary = prev && OPERAND_END.test(prev.text) && next && !/^[)\],;]$/.test(next.text);
			if (binary) out.push({ pos: t.start, rank: RANK[t.text], depth: t.depth });
		}
	});
	return out.filter((c) => c.pos > 0 && c.pos < str.length && str.slice(0, c.pos).trim() && str.slice(c.pos).trim());
}

/** Wraps `str` to `width` columns; returns the physical lines (indent included). */
function wrap(str, firstIndent, contIndent, width) {
	const whole = firstIndent + str;
	if (visualWidth(whole) <= width) return [whole];
	const cands = candidates(str);
	if (!cands.length) return [whole];
	const depth = Math.min(...cands.map((c) => c.depth));
	const atDepth = cands.filter((c) => c.depth === depth);
	const rank = Math.min(...atDepth.map((c) => c.rank));
	const cuts = [...new Set(atDepth.filter((c) => c.rank === rank).map((c) => c.pos))].sort((a, b) => a - b);

	const pieces = [];
	let from = 0;
	for (const cut of [...cuts, str.length]) {
		pieces.push(str.slice(from, cut).trim());
		from = cut;
	}

	const lines = [];
	let cur = null;
	pieces.forEach((piece, k) => {
		if (k === 0) {
			const sub = wrap(piece, firstIndent, contIndent, width);
			lines.push(...sub.slice(0, -1));
			cur = sub[sub.length - 1];
		} else if (visualWidth(cur + ' ' + piece) <= width) {
			cur += ' ' + piece;
		} else {
			lines.push(cur);
			const sub = wrap(piece, contIndent, contIndent, width);
			lines.push(...sub.slice(0, -1));
			cur = sub[sub.length - 1];
		}
	});
	lines.push(cur);
	return lines;
}

/** Net parenthesis depth of a line (strings and chars ignored). */
function parenDelta(line) {
	let d = 0;
	for (const m of line.matchAll(TOKEN_RE)) {
		if (m[0] === '(' || m[0] === '[') d++;
		else if (m[0] === ')' || m[0] === ']') d--;
	}
	return d;
}

const CONTROL = /^(?:else\s+)?(?:if|while|for|switch)\b/;

/** True when `text` (the statement so far) cannot be continued by a deeper line. */
function isComplete(text, depth) {
	if (depth > 0) return false;
	return /[;{}:]$/.test(text) || /^(?:else|do)$/.test(text) || (CONTROL.test(text) && text.endsWith(')'));
}

function joinLines(lines) {
	return lines
		.map((l) => l.trim())
		.reduce((acc, l) => (/[(\[]$/.test(acc) || /^[)\],]/.test(l) ? acc + l : acc + ' ' + l));
}

const strip = (s) => s.replace(/\s+/g, '');

/** Reflows every wrapped (or too long) statement of `text`. Returns the text unchanged when nothing applies. */
function reflow(text, width = 80) {
	const lines = text.split('\n');
	const out = [];
	let inComment = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (inComment || /^\s*\/\*/.test(line) || /\/\//.test(line) || /^\s*#/.test(line) || !trimmed) {
			if (/\/\*/.test(line) && !/\*\//.test(line.slice(line.indexOf('/*')))) inComment = true;
			if (inComment && /\*\//.test(line)) inComment = false;
			out.push(line);
			continue;
		}

		// gather the physical lines of this statement
		const baseWidth = visualWidth(indentOf(line));
		let depth = parenDelta(trimmed);
		let soFar = trimmed;
		let j = i;
		while (j + 1 < lines.length) {
			const next = lines[j + 1];
			const nt = next.trim();
			if (!nt || visualWidth(indentOf(next)) <= baseWidth || isComplete(soFar, depth)) break;
			depth += parenDelta(nt);
			soFar = joinLines([soFar, nt]);
			j++;
		}

		const group = lines.slice(i, j + 1);
		const body = group.map((l) => l.trim());
		const tooLong = group.some((l) => visualWidth(l) > width);
		const eligible =
			(group.length > 1 || tooLong) &&
			!body.some((l) => /\t|\/\*|\/\/|[{}]/.test(l)) &&
			!/^(?:#|else$|do$)/.test(body[0]);
		if (eligible) {
			const contIndent = group.length > 1 ? indentOf(group[1]) : indentOf(line) + '\t';
			const joined = joinLines(group);
			const wrapped = wrap(joined, indentOf(line), contIndent, width);
			if (strip(wrapped.join('')) === strip(group.join(''))) {
				out.push(...wrapped);
				i = j;
				continue;
			}
		}
		out.push(line);
	}
	return out.join('\n');
}

module.exports = { reflow, wrap, visualWidth };
