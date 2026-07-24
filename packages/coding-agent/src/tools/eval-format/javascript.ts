type PendingBreak = "brace" | "statement" | "close";

interface ParenFrame {
	forHeader: boolean;
	controlHeader: boolean;
}

interface TemplateTextFrame {
	kind: "text";
}

interface TemplateExpressionFrame {
	kind: "expression";
	braceDepth: number;
	regexAllowed: boolean;
}

type TemplateFrame = TemplateTextFrame | TemplateExpressionFrame;

const CONTROL_HEADER_WORDS: Record<string, true> = {
	catch: true,
	for: true,
	if: true,
	switch: true,
	while: true,
	with: true,
};
const REGEX_PREFIX_WORDS: Record<string, true> = {
	await: true,
	case: true,
	delete: true,
	do: true,
	else: true,
	extends: true,
	in: true,
	instanceof: true,
	new: true,
	of: true,
	return: true,
	throw: true,
	typeof: true,
	void: true,
	yield: true,
};
const CLOSE_CONTINUATIONS = ["else", "catch", "finally"];

function isIdentifierStart(char: string): boolean {
	if (!char) return false;
	const code = char.charCodeAt(0);
	return char === "$" || char === "_" || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code >= 128;
}

function isIdentifierPart(char: string): boolean {
	if (!char) return false;
	const code = char.charCodeAt(0);
	return isIdentifierStart(char) || (code >= 48 && code <= 57);
}

function scanIdentifier(source: string, start: number): number {
	let index = start + 1;
	while (index < source.length && isIdentifierPart(source[index])) index++;
	return index;
}

function scanNumber(source: string, start: number): number {
	let index = start + 1;
	while (index < source.length && /[\w.]/.test(source[index])) index++;
	return index;
}

function scanQuoted(source: string, start: number): number {
	const quote = source[start];
	let index = start + 1;
	while (index < source.length) {
		if (source[index] === "\\") {
			index += index + 1 < source.length ? 2 : 1;
			continue;
		}
		if (source[index] === quote) return index + 1;
		index++;
	}
	return source.length;
}

function scanLineComment(source: string, start: number): number {
	let index = start + 2;
	while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index++;
	return index;
}

function scanBlockComment(source: string, start: number): number {
	let index = start + 2;
	while (index < source.length) {
		if (source[index] === "*" && source[index + 1] === "/") return index + 2;
		index++;
	}
	return source.length;
}

function scanRegex(source: string, start: number): number {
	let index = start + 1;
	let inCharacterClass = false;
	while (index < source.length) {
		const char = source[index];
		if (char === "\\") {
			index += index + 1 < source.length ? 2 : 1;
			continue;
		}
		if (char === "[") inCharacterClass = true;
		else if (char === "]") inCharacterClass = false;
		else if (char === "/" && !inCharacterClass) {
			index++;
			while (index < source.length && isIdentifierPart(source[index])) index++;
			return index;
		}
		index++;
	}
	return source.length;
}

function scanTemplate(source: string, start: number): number {
	const frames: TemplateFrame[] = [{ kind: "text" }];
	let index = start + 1;

	while (index < source.length) {
		const frame = frames[frames.length - 1];
		if (!frame) return index;
		const char = source[index];
		const next = source[index + 1];

		if (frame.kind === "text") {
			if (char === "\\") {
				index += index + 1 < source.length ? 2 : 1;
			} else if (char === "`") {
				frames.pop();
				index++;
				if (frames.length === 0) return index;
				const parent = frames[frames.length - 1];
				if (parent?.kind === "expression") parent.regexAllowed = false;
			} else if (char === "$" && next === "{") {
				frames.push({ kind: "expression", braceDepth: 1, regexAllowed: true });
				index += 2;
			} else {
				index++;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			index = scanQuoted(source, index);
			frame.regexAllowed = false;
			continue;
		}
		if (char === "`") {
			frames.push({ kind: "text" });
			index++;
			continue;
		}
		if (char === "/" && next === "/") {
			index = scanLineComment(source, index);
			continue;
		}
		if (char === "/" && next === "*") {
			index = scanBlockComment(source, index);
			continue;
		}
		if (char === "/" && frame.regexAllowed) {
			index = scanRegex(source, index);
			frame.regexAllowed = false;
			continue;
		}
		if (isIdentifierStart(char)) {
			const end = scanIdentifier(source, index);
			frame.regexAllowed = REGEX_PREFIX_WORDS[source.slice(index, end)] === true;
			index = end;
			continue;
		}
		if (char >= "0" && char <= "9") {
			index = scanNumber(source, index);
			frame.regexAllowed = false;
			continue;
		}
		if (char === "{") {
			frame.braceDepth++;
			frame.regexAllowed = true;
			index++;
			continue;
		}
		if (char === "}") {
			frame.braceDepth--;
			index++;
			if (frame.braceDepth === 0) frames.pop();
			else frame.regexAllowed = false;
			continue;
		}
		if ((char === "+" && next === "+") || (char === "-" && next === "-")) {
			frame.regexAllowed = false;
			index += 2;
			continue;
		}
		if (char === ")" || char === "]" || char === ".") frame.regexAllowed = false;
		else if (!/\s/.test(char)) frame.regexAllowed = true;
		index++;
	}

	return source.length;
}

function canJoinCloseWithWord(word: string, atSourceEnd: boolean): boolean {
	return CLOSE_CONTINUATIONS.some(
		(keyword) => keyword === word || (atSourceEnd && keyword.startsWith(word)),
	);
}

function canAttachToClose(char: string): boolean {
	return "();,.)]:?+-*/%&|^<>=!".includes(char);
}

/** Formats JavaScript/TypeScript-like eval source for safe, stable display without requiring valid syntax. */
export function formatJavaScriptForDisplay(source: string): string {
	const output: string[] = [];
	const parens: ParenFrame[] = [];
	let index = 0;
	let indent = 0;
	let atLineStart = true;
	let lastChar = "";
	let pendingWhitespace = "";
	let pendingBreak: PendingBreak | undefined;
	let afterForSemicolon = false;
	let regexAllowed = true;
	let pendingFor = false;
	let lastWord = "";
	let lastTokenWasWord = false;

	function append(text: string): void {
		if (!text) return;
		output.push(text);
		lastChar = text[text.length - 1];
		const newline = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
		atLineStart = newline >= 0 ? newline === text.length - 1 : false;
	}

	function newline(): void {
		output.push("\n");
		lastChar = "\n";
		atLineStart = true;
	}

	function whitespaceWidth(text: string): number {
		let width = 0;
		for (const char of text) width += char === "\t" ? 4 - (width % 4) : 1;
		return width;
	}

	function flushWhitespace(): void {
		if (atLineStart) {
			const width = Math.max(indent * 4, whitespaceWidth(pendingWhitespace));
			if (width > 0) append(" ".repeat(width));
		} else {
			append(pendingWhitespace);
		}
		pendingWhitespace = "";
	}

	function forceBreak(): void {
		pendingWhitespace = "";
		if (!atLineStart) newline();
		pendingBreak = undefined;
	}

	function prepareToken(kind: "word" | "punctuation" | "value", text: string, end: number): void {
		if (pendingBreak === "close") {
			if (kind === "word" && canJoinCloseWithWord(text, end === source.length)) {
				pendingWhitespace = "";
				if (!atLineStart && lastChar !== " ") append(" ");
				pendingBreak = undefined;
			} else if (kind === "punctuation" && canAttachToClose(text[0])) {
				pendingWhitespace = "";
				pendingBreak = undefined;
			} else {
				forceBreak();
			}
		} else if (pendingBreak) {
			forceBreak();
		}

		if (afterForSemicolon) {
			if (text !== ";" && text !== ")" && !atLineStart && pendingWhitespace.length === 0) append(" ");
			afterForSemicolon = false;
		}
	}

	function appendComment(end: number): void {
		const comment = source.slice(index, end);
		if (pendingBreak) {
			if (pendingWhitespace.length > 0) append(pendingWhitespace);
			else if (!atLineStart) append(" ");
			pendingWhitespace = "";
		} else {
			flushWhitespace();
		}
		append(comment);
		if (comment.includes("\n") || comment.includes("\r")) pendingBreak = undefined;
		if (afterForSemicolon) afterForSemicolon = false;
	}

	while (index < source.length) {
		const char = source[index];
		const next = source[index + 1];

		if (char === "\n" || char === "\r") {
			pendingWhitespace = "";
			pendingBreak = undefined;
			afterForSemicolon = false;
			newline();
			index += char === "\r" && next === "\n" ? 2 : 1;
			continue;
		}
		if (/\s/.test(char)) {
			const start = index;
			while (index < source.length && /[^\S\r\n]/.test(source[index])) index++;
			pendingWhitespace += source.slice(start, index);
			continue;
		}
		if (char === "/" && next === "/") {
			const end = scanLineComment(source, index);
			appendComment(end);
			index = end;
			continue;
		}
		if (char === "/" && next === "*") {
			const end = scanBlockComment(source, index);
			appendComment(end);
			index = end;
			continue;
		}
		if (char === "'" || char === '"') {
			const end = scanQuoted(source, index);
			prepareToken("value", char, end);
			flushWhitespace();
			append(source.slice(index, end));
			index = end;
			regexAllowed = false;
			pendingFor = false;
			lastTokenWasWord = false;
			continue;
		}
		if (char === "`") {
			const end = scanTemplate(source, index);
			prepareToken("value", char, end);
			flushWhitespace();
			append(source.slice(index, end));
			index = end;
			regexAllowed = false;
			pendingFor = false;
			lastTokenWasWord = false;
			continue;
		}
		if (char === "/" && regexAllowed) {
			const end = scanRegex(source, index);
			prepareToken("value", char, end);
			flushWhitespace();
			append(source.slice(index, end));
			index = end;
			regexAllowed = false;
			pendingFor = false;
			lastTokenWasWord = false;
			continue;
		}
		if (isIdentifierStart(char)) {
			const end = scanIdentifier(source, index);
			const word = source.slice(index, end);
			prepareToken("word", word, end);
			flushWhitespace();
			append(word);
			if (word === "for") pendingFor = true;
			else if (!(pendingFor && word === "await")) pendingFor = false;
			regexAllowed = REGEX_PREFIX_WORDS[word] === true;
			lastWord = word;
			lastTokenWasWord = true;
			index = end;
			continue;
		}
		if (char >= "0" && char <= "9") {
			const end = scanNumber(source, index);
			prepareToken("value", char, end);
			flushWhitespace();
			append(source.slice(index, end));
			index = end;
			regexAllowed = false;
			pendingFor = false;
			lastTokenWasWord = false;
			continue;
		}
		if (char === "{") {
			prepareToken("punctuation", char, index + 1);
			const hadWhitespace = pendingWhitespace.length > 0;
			flushWhitespace();
			if (!atLineStart && !hadWhitespace && !" ([{".includes(lastChar)) append(" ");
			append(char);
			indent++;
			pendingBreak = "brace";
			regexAllowed = true;
			pendingFor = false;
			lastTokenWasWord = false;
			index++;
			continue;
		}
		if (char === "}") {
			prepareToken("punctuation", char, index + 1);
			pendingWhitespace = "";
			if (!atLineStart) newline();
			indent = Math.max(0, indent - 1);
			flushWhitespace();
			append(char);
			pendingBreak = "close";
			regexAllowed = false;
			pendingFor = false;
			lastTokenWasWord = false;
			index++;
			continue;
		}
		if (char === ";") {
			prepareToken("punctuation", char, index + 1);
			flushWhitespace();
			append(char);
			const frame = parens[parens.length - 1];
			if (frame?.forHeader) afterForSemicolon = true;
			else pendingBreak = "statement";
			regexAllowed = true;
			pendingFor = false;
			lastTokenWasWord = false;
			index++;
			continue;
		}
		if (char === "(") {
			const forHeader = pendingFor;
			const controlHeader = forHeader || (lastTokenWasWord && CONTROL_HEADER_WORDS[lastWord] === true);
			prepareToken("punctuation", char, index + 1);
			const needsSpace = controlHeader && pendingWhitespace.length === 0 && !atLineStart;
			flushWhitespace();
			if (needsSpace) append(" ");
			append(char);
			parens.push({ forHeader, controlHeader });
			regexAllowed = true;
			pendingFor = false;
			lastTokenWasWord = false;
			index++;
			continue;
		}
		if (char === ")") {
			prepareToken("punctuation", char, index + 1);
			flushWhitespace();
			append(char);
			const frame = parens.pop();
			regexAllowed = frame?.controlHeader ?? false;
			pendingFor = false;
			lastTokenWasWord = false;
			index++;
			continue;
		}

		const doubledPostfix = (char === "+" && next === "+") || (char === "-" && next === "-");
		const token = doubledPostfix ? source.slice(index, index + 2) : char;
		prepareToken("punctuation", token, index + token.length);
		flushWhitespace();
		append(token);
		if (doubledPostfix || char === "]" || char === ".") regexAllowed = false;
		else regexAllowed = true;
		pendingFor = false;
		lastTokenWasWord = false;
		index += token.length;
	}

	return output.join("");
}
