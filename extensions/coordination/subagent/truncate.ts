export interface OutputLimits {
	bytes?: number;
	lines?: number;
}

export interface OutputMetrics {
	byteCount: number;
	lineCount: number;
	charCount: number;
}

export interface TruncationResult {
	text: string;
	truncated: boolean;
	marker?: string;
	headBytes: number;
	headLines: number;
	raw: OutputMetrics;
}

const DEFAULT_MARKER = "[[TRUNCATED]]";

function countLines(text: string): number {
	if (!text) return 0;
	let lines = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) lines++;
	}
	return lines;
}

function utf8ByteLengthForCodePoint(codePoint: number): number {
	if (codePoint <= 0x7f) return 1;
	if (codePoint <= 0x7ff) return 2;
	if (codePoint <= 0xffff) return 3;
	return 4;
}

export function measureOutput(text: string): OutputMetrics {
	return {
		byteCount: Buffer.byteLength(text, "utf8"),
		lineCount: countLines(text),
		charCount: text.length,
	};
}

export function truncateOutputHead(
	text: string,
	limits?: OutputLimits,
	markerPrefix: string = DEFAULT_MARKER,
): TruncationResult {
	const raw = measureOutput(text);

	const maxBytes = limits?.bytes ?? Number.POSITIVE_INFINITY;
	const maxLines = limits?.lines ?? Number.POSITIVE_INFINITY;

	if (raw.byteCount <= maxBytes && raw.lineCount <= maxLines) {
		return {
			text,
			truncated: false,
			headBytes: raw.byteCount,
			headLines: raw.lineCount,
			raw,
		};
	}

	let bytes = 0;
	let lineCount = text.length > 0 ? 1 : 0;
	let endIndex = 0;
	let truncated = false;

	if (maxBytes <= 0 || maxLines <= 0) {
		truncated = true;
		endIndex = 0;
	}

	for (let i = 0; i < text.length && !truncated; ) {
		const codePoint = text.codePointAt(i);
		if (codePoint === undefined) break;
		const step = codePoint > 0xffff ? 2 : 1;
		const byteLen = utf8ByteLengthForCodePoint(codePoint);

		if (bytes + byteLen > maxBytes) {
			truncated = true;
			break;
		}

		if (codePoint === 10 && lineCount + 1 > maxLines) {
			truncated = true;
			break;
		}

		bytes += byteLen;
		if (codePoint === 10) {
			lineCount++;
		}

		endIndex = i + step;
		i += step;
	}

	const head = text.slice(0, endIndex);
	const headLines = countLines(head);

	const limitsText = [
		limits?.bytes ? `${limits.bytes} bytes` : undefined,
		limits?.lines ? `${limits.lines} lines` : undefined,
	]
		.filter(Boolean)
		.join(", ");
	const marker = `${markerPrefix} output limited to ${limitsText || "configured limits"}.\n`;

	return {
		text: marker + head,
		truncated,
		marker,
		headBytes: bytes,
		headLines,
		raw,
	};
}
