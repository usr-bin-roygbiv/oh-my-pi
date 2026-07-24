const INDENT = "    ";

const OPENING_KEYWORDS = new Set(["class", "module", "def", "if", "unless", "case", "begin", "while", "until", "for"]);
const BRANCH_KEYWORDS = new Set(["else", "elsif", "when", "rescue", "ensure"]);
const REGEXP_PREFIX_KEYWORDS = new Set([
	"and",
	"begin",
	"case",
	"do",
	"else",
	"elsif",
	"if",
	"in",
	"not",
	"or",
	"raise",
	"rescue",
	"return",
	"then",
	"unless",
	"until",
	"when",
	"while",
	"yield",
]);

interface WordToken {
	kind: "word";
	value: string;
	eligible: boolean;
}

interface PunctuationToken {
	kind: "punctuation";
	value: string;
}

interface LiteralToken {
	kind: "literal";
}

type StructuralToken = WordToken | PunctuationToken | LiteralToken;

type Quote = "'" | '"' | "`";

interface QuotedContext {
	kind: "quoted";
	quote: Quote;
	interpolated: boolean;
	escaped: boolean;
}

interface PercentContext {
	kind: "percent";
	open: string;
	close: string;
	depth: number;
	interpolated: boolean;
	escaped: boolean;
}

interface RegexpContext {
	kind: "regexp";
	escaped: boolean;
	inCharacterClass: boolean;
}

interface InterpolationContext {
	kind: "interpolation";
	braceDepth: number;
	canStartExpression: boolean;
}

interface CommentContext {
	kind: "comment";
}

type LexicalContext = QuotedContext | PercentContext | RegexpContext | InterpolationContext | CommentContext;

interface PercentLiteralStart {
	end: number;
	open: string;
	close: string;
	interpolated: boolean;
}

interface LineLayout {
	indent: number;
	nextDepth: number;
}

function isHorizontalWhitespace(character: string): boolean {
	return character === " " || character === "\t" || character === "\f" || character === "\v";
}

function isIdentifierStart(character: string | undefined): boolean {
	if (character === undefined) return false;
	const code = character.charCodeAt(0);
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || character === "_";
}

function isIdentifierPart(character: string | undefined): boolean {
	if (character === undefined) return false;
	const code = character.charCodeAt(0);
	return isIdentifierStart(character) || (code >= 48 && code <= 57);
}

function identifierEnd(source: string, start: number): number {
	let end = start + 1;
	while (isIdentifierPart(source[end])) end++;
	if (source[end] === "?" || source[end] === "!") end++;
	return end;
}

function pairedDelimiter(open: string): string {
	switch (open) {
		case "(":
			return ")";
		case "[":
			return "]";
		case "{":
			return "}";
		case "<":
			return ">";
		default:
			return open;
	}
}

function percentLiteralStart(source: string, start: number): PercentLiteralStart | undefined {
	let delimiterIndex = start + 1;
	let type = "";
	const candidateType = source[delimiterIndex];
	if (candidateType !== undefined && "qQwWiIxrs".includes(candidateType)) {
		type = candidateType;
		delimiterIndex++;
	}

	const open = source[delimiterIndex];
	if (open === undefined || /[A-Za-z0-9_\s]/.test(open)) return undefined;

	return {
		end: delimiterIndex + 1,
		open,
		close: pairedDelimiter(open),
		interpolated: type === "" || type === "Q" || type === "W" || type === "I" || type === "x" || type === "r",
	};
}

function isMatchingDelimiter(open: string, close: string): boolean {
	return (
		(open === "(" && close === ")") ||
		(open === "[" && close === "]") ||
		(open === "{" && close === "}")
	);
}

function isStandaloneAssignment(tokens: StructuralToken[], index: number): boolean {
	const previous = tokens[index - 1];
	const next = tokens[index + 1];
	if (next?.kind === "punctuation" && (next.value === "=" || next.value === ">" || next.value === "(")) return false;
	if (
		previous?.kind === "punctuation" &&
		(previous.value === "=" || previous.value === "!" || previous.value === "<" || previous.value === ">" || previous.value === "~")
	) {
		return false;
	}
	return true;
}

function lineLayout(tokens: StructuralToken[], depth: number): LineLayout {
	const first = tokens[0];
	const leadingKeyword = first?.kind === "word" && first.eligible ? first.value : undefined;
	const leadingEnd = leadingKeyword === "end";
	const branch = leadingKeyword !== undefined && BRANCH_KEYWORDS.has(leadingKeyword);

	let indent = depth;
	if (leadingEnd || branch) indent = Math.max(0, depth - 1);

	let endCount = 0;
	let hasDo = false;
	for (const token of tokens) {
		if (token.kind !== "word" || !token.eligible) continue;
		if (token.value === "end") endCount++;
		if (token.value === "do") hasDo = true;
	}

	let opens = leadingKeyword !== undefined && OPENING_KEYWORDS.has(leadingKeyword);
	if (leadingKeyword === "def") {
		for (let index = 1; index < tokens.length; index++) {
			const token = tokens[index];
			if (token.kind === "punctuation" && token.value === "=" && isStandaloneAssignment(tokens, index)) {
				opens = false;
				break;
			}
		}
	}
	if (!leadingEnd && !branch && hasDo) opens = true;

	return {
		indent,
		nextDepth: Math.max(0, depth + (opens ? 1 : 0) - endCount),
	};
}

function formatRubyPrefix(source: string): string {
	const output: string[] = [];
	const contexts: LexicalContext[] = [];
	const delimiters: string[] = [];
	let tokens: StructuralToken[] = [];
	let lineParts: string[] = [];
	let lineHasVisibleText = false;
	let preserveLeadingWhitespace = false;
	let pendingVirtualBreak = false;
	let blockDepth = 0;
	let rootCanStartExpression = true;

	const append = (text: string): void => {
		lineParts.push(text);
		if (lineHasVisibleText) return;
		for (let index = 0; index < text.length; index++) {
			if (!isHorizontalWhitespace(text[index])) {
				lineHasVisibleText = true;
				return;
			}
		}
	};

	const currentCodeCanStartExpression = (): boolean => {
		for (let index = contexts.length - 1; index >= 0; index--) {
			const context = contexts[index];
			if (context.kind === "interpolation") return context.canStartExpression;
		}
		return rootCanStartExpression;
	};

	const setCurrentCodeCanStartExpression = (value: boolean): void => {
		for (let index = contexts.length - 1; index >= 0; index--) {
			const context = contexts[index];
			if (context.kind === "interpolation") {
				context.canStartExpression = value;
				return;
			}
		}
		rootCanStartExpression = value;
	};

	const resetLine = (): void => {
		tokens = [];
		lineParts = [];
		lineHasVisibleText = false;
		preserveLeadingWhitespace = contexts.length > 0 || delimiters.length > 0;
	};

	const flushLine = (ending: string): void => {
		const raw = lineParts.join("");
		const layout = lineLayout(tokens, blockDepth);
		blockDepth = layout.nextDepth;

		if (preserveLeadingWhitespace) {
			output.push(raw, ending);
			return;
		}

		let contentStart = 0;
		while (contentStart < raw.length && isHorizontalWhitespace(raw[contentStart])) contentStart++;
		const content = raw.slice(contentStart);
		output.push(content.length === 0 ? "" : INDENT.repeat(layout.indent) + content, ending);
	};

	const addPunctuation = (value: string): void => {
		if (contexts.length === 0 && delimiters.length === 0) tokens.push({ kind: "punctuation", value });
	};

	const addLiteral = (): void => {
		if (contexts.length === 0 && delimiters.length === 0) tokens.push({ kind: "literal" });
	};

	for (let index = 0; index < source.length; ) {
		const character = source[index];
		if (character === "\n" || character === "\r") {
			const ending = character === "\r" && source[index + 1] === "\n" ? "\r\n" : character;
			const top = contexts[contexts.length - 1];
			if (top?.kind === "comment") {
				contexts.pop();
			} else if (top?.kind === "quoted" || top?.kind === "percent" || top?.kind === "regexp") {
				top.escaped = false;
			}

			const codeContext = contexts[contexts.length - 1];
			if (codeContext?.kind === "interpolation") {
				codeContext.canStartExpression = true;
			} else if (contexts.length === 0 && delimiters.length === 0) {
				rootCanStartExpression = true;
			}

			if (pendingVirtualBreak && !lineHasVisibleText) {
				pendingVirtualBreak = false;
				resetLine();
			} else {
				flushLine(ending);
				pendingVirtualBreak = false;
				resetLine();
			}
			index += ending.length;
			continue;
		}

		const top = contexts[contexts.length - 1];
		if (top?.kind === "comment") {
			append(character);
			index++;
			continue;
		}

		if (top?.kind === "quoted") {
			append(character);
			if (top.escaped) {
				top.escaped = false;
				index++;
				continue;
			}
			if (character === "\\") {
				top.escaped = true;
				index++;
				continue;
			}
			if (top.interpolated && character === "#" && source[index + 1] === "{") {
				append("{");
				contexts.push({ kind: "interpolation", braceDepth: 1, canStartExpression: true });
				index += 2;
				continue;
			}
			if (character === top.quote) {
				contexts.pop();
				setCurrentCodeCanStartExpression(false);
			}
			index++;
			continue;
		}

		if (top?.kind === "percent") {
			append(character);
			if (top.escaped) {
				top.escaped = false;
				index++;
				continue;
			}
			if (character === "\\") {
				top.escaped = true;
				index++;
				continue;
			}
			if (top.interpolated && character === "#" && source[index + 1] === "{") {
				append("{");
				contexts.push({ kind: "interpolation", braceDepth: 1, canStartExpression: true });
				index += 2;
				continue;
			}
			if (top.open !== top.close && character === top.open) {
				top.depth++;
			} else if (character === top.close) {
				top.depth--;
				if (top.depth === 0) {
					contexts.pop();
					setCurrentCodeCanStartExpression(false);
				}
			}
			index++;
			continue;
		}

		if (top?.kind === "regexp") {
			append(character);
			if (top.escaped) {
				top.escaped = false;
				index++;
				continue;
			}
			if (character === "\\") {
				top.escaped = true;
				index++;
				continue;
			}
			if (character === "#" && source[index + 1] === "{") {
				append("{");
				contexts.push({ kind: "interpolation", braceDepth: 1, canStartExpression: true });
				index += 2;
				continue;
			}
			if (character === "[" && !top.inCharacterClass) {
				top.inCharacterClass = true;
			} else if (character === "]" && top.inCharacterClass) {
				top.inCharacterClass = false;
			} else if (character === "/" && !top.inCharacterClass) {
				contexts.pop();
				setCurrentCodeCanStartExpression(false);
			}
			index++;
			continue;
		}

		const interpolation = top?.kind === "interpolation" ? top : undefined;
		const inRootCode = interpolation === undefined;

		if (interpolation !== undefined && character === "}") {
			append(character);
			interpolation.braceDepth--;
			if (interpolation.braceDepth === 0) {
				contexts.pop();
				setCurrentCodeCanStartExpression(false);
			} else {
				interpolation.canStartExpression = false;
			}
			index++;
			continue;
		}

		if (character === "#") {
			append(character);
			contexts.push({ kind: "comment" });
			index++;
			continue;
		}

		if (character === "'" || character === '"' || character === "`") {
			addLiteral();
			append(character);
			contexts.push({
				kind: "quoted",
				quote: character,
				interpolated: character !== "'",
				escaped: false,
			});
			index++;
			continue;
		}

		if (character === "%") {
			const start = percentLiteralStart(source, index);
			if (start !== undefined) {
				addLiteral();
				append(source.slice(index, start.end));
				contexts.push({
					kind: "percent",
					open: start.open,
					close: start.close,
					depth: 1,
					interpolated: start.interpolated,
					escaped: false,
				});
				index = start.end;
				continue;
			}
		}

		if (character === "/" && currentCodeCanStartExpression()) {
			addLiteral();
			append(character);
			contexts.push({ kind: "regexp", escaped: false, inCharacterClass: false });
			index++;
			continue;
		}

		if (character === "?" && currentCodeCanStartExpression()) {
			const next = source[index + 1];
			if (next !== undefined && !/\s/.test(next)) {
				addLiteral();
				let end = index + 2;
				if (next === "\\" && source[end] !== undefined) end++;
				append(source.slice(index, end));
				setCurrentCodeCanStartExpression(false);
				index = end;
				continue;
			}
		}

		if (isIdentifierStart(character)) {
			const end = identifierEnd(source, index);
			const word = source.slice(index, end);
			append(word);

			if (inRootCode && delimiters.length === 0) {
				const previous = tokens[tokens.length - 1];
				const blockedByPrefix =
					previous?.kind === "punctuation" &&
					(previous.value === ":" || previous.value === "." || previous.value === "@" || previous.value === "$");
				const label = source[end] === ":" && source[end + 1] !== ":";
				tokens.push({ kind: "word", value: word, eligible: !blockedByPrefix && !label });
			}

			setCurrentCodeCanStartExpression(REGEXP_PREFIX_KEYWORDS.has(word));
			index = end;
			continue;
		}

		if (interpolation !== undefined && character === "{") {
			append(character);
			interpolation.braceDepth++;
			interpolation.canStartExpression = true;
			index++;
			continue;
		}

		if (inRootCode && (character === "(" || character === "[" || character === "{")) {
			addPunctuation(character);
			append(character);
			delimiters.push(character);
			rootCanStartExpression = true;
			index++;
			continue;
		}

		if (inRootCode && (character === ")" || character === "]" || character === "}")) {
			append(character);
			const open = delimiters[delimiters.length - 1];
			if (open !== undefined && isMatchingDelimiter(open, character)) delimiters.pop();
			addPunctuation(character);
			rootCanStartExpression = false;
			index++;
			continue;
		}

		if (character === ";") {
			append(character);
			if (inRootCode && delimiters.length === 0) {
				addPunctuation(character);
				rootCanStartExpression = true;
				flushLine("\n");
				pendingVirtualBreak = true;
				resetLine();
			} else {
				setCurrentCodeCanStartExpression(true);
			}
			index++;
			continue;
		}

		append(character);
		if (isHorizontalWhitespace(character)) {
			index++;
			continue;
		}

		if (inRootCode && delimiters.length === 0) tokens.push({ kind: "punctuation", value: character });
		if (character === "." || character === ")" || character === "]" || character === "}") {
			setCurrentCodeCanStartExpression(false);
		} else if ("=,:!~+-*%&|^<>?".includes(character) || character === "/") {
			setCurrentCodeCanStartExpression(true);
		} else {
			setCurrentCodeCanStartExpression(false);
		}
		index++;
	}

	if (lineParts.length > 0 && !(pendingVirtualBreak && !lineHasVisibleText)) flushLine("");
	return output.join("");
}

/** Formats an arbitrary Ruby source prefix for display without requiring valid syntax. */
export function formatRubyForDisplay(source: string): string {
	try {
		return formatRubyPrefix(source);
	} catch {
		return source;
	}
}
