import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "../../../config.ts";
import { applyAssistantRenderedLineTransforms } from "../../../core/assistant-render-transforms.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const MIN_ASSISTANT_TEXT_WIDTH = 48;
const MAX_ASSISTANT_TEXT_WIDTH = 180;
const OSC_PREFIX_PATTERN = /^(?:\x1b\][^\x07]*\x07)*/;
const DIALOGUE_CLOSE_BY_OPEN: Record<string, string> = {
	'"': '"',
	"“": "”",
	"「": "」",
	"『": "』",
};
const DIALOGUE_CLOSE_CHARS = new Set(Object.values(DIALOGUE_CLOSE_BY_OPEN));
const ASSISTANT_TEXT_DISPLAY_TRANSFORMS_KEY = Symbol.for("pi.assistantTextDisplayTransforms");
const ASSISTANT_TEXT_DISPLAY_TRANSFORMS_VERSION_KEY = Symbol.for("pi.assistantTextDisplayTransformsVersion");

type AssistantTextDisplayTransform = (text: string) => string;

interface AssistantReadingSettings {
	dialogueHighlight: boolean;
	textWidth?: number;
}

function getAssistantReadingSettings(): AssistantReadingSettings {
	const settingsPath = join(getAgentDir(), "settings.json");
	if (!existsSync(settingsPath)) {
		return { dialogueHighlight: true };
	}

	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
			assistantDialogueHighlight?: unknown;
			assistantTextWidth?: unknown;
		};
		const value = settings.assistantTextWidth;
		let textWidth: number | undefined;
		if (!(value === undefined || value === null || value === false || value === 0)) {
			if (typeof value === "number" && Number.isFinite(value)) {
				textWidth = Math.max(MIN_ASSISTANT_TEXT_WIDTH, Math.min(MAX_ASSISTANT_TEXT_WIDTH, Math.floor(value)));
			}
		}
		return {
			dialogueHighlight: settings.assistantDialogueHighlight !== false,
			textWidth,
		};
	} catch {
		return { dialogueHighlight: true };
	}
}

function getAssistantTextDisplayTransforms(): AssistantTextDisplayTransform[] {
	const registry = (globalThis as Record<symbol, unknown>)[ASSISTANT_TEXT_DISPLAY_TRANSFORMS_KEY];
	if (!Array.isArray(registry)) {
		return [];
	}
	return registry.filter((transform): transform is AssistantTextDisplayTransform => typeof transform === "function");
}

function applyAssistantTextDisplayTransforms(text: string): string {
	let transformed = text;
	for (const transform of getAssistantTextDisplayTransforms()) {
		try {
			transformed = transform(transformed);
		} catch {
			// Display transforms are optional extension hooks; a failed extension should not break rendering.
		}
	}
	return transformed;
}

function getAssistantTextDisplayTransformsVersion(): number {
	const version = (globalThis as Record<symbol, unknown>)[ASSISTANT_TEXT_DISPLAY_TRANSFORMS_VERSION_KEY];
	return typeof version === "number" && Number.isFinite(version) ? version : 0;
}

function indentLine(line: string, spaces: number): string {
	if (spaces <= 0) {
		return line;
	}
	const match = line.match(OSC_PREFIX_PATTERN);
	const prefix = match?.[0] ?? "";
	return `${prefix}${" ".repeat(spaces)}${line.slice(prefix.length)}`;
}

function extractAnsiCode(str: string, pos: number): { code: string; length: number } | null {
	if (pos >= str.length || str[pos] !== "\x1b") return null;

	const next = str[pos + 1];
	if (next === "[") {
		let j = pos + 2;
		while (j < str.length && !/[mGKHJ]/.test(str[j]!)) j++;
		return j < str.length ? { code: str.substring(pos, j + 1), length: j + 1 - pos } : null;
	}
	if (next === "]") {
		let j = pos + 2;
		while (j < str.length) {
			if (str[j] === "\x07") return { code: str.substring(pos, j + 1), length: j + 1 - pos };
			if (str[j] === "\x1b" && str[j + 1] === "\\") return { code: str.substring(pos, j + 2), length: j + 2 - pos };
			j++;
		}
	}
	return null;
}

function applyDialogueColor(lines: string[]): string[] {
	let closeChar: string | undefined;
	const dialogueColor = theme.getFgAnsi("success");
	const bodyColor = theme.getFgAnsi("text");

	return lines.map((line) => {
		let result = "";
		let index = 0;

		while (index < line.length) {
			const ansi = extractAnsiCode(line, index);
			if (ansi) {
				result += ansi.code;
				index += ansi.length;
				continue;
			}

			const char = line[index]!;
			const openCloseChar = DIALOGUE_CLOSE_BY_OPEN[char];
			const isClosing = closeChar !== undefined && char === closeChar;
			const shouldColor = closeChar !== undefined || openCloseChar !== undefined;

			result += shouldColor ? `${dialogueColor}${char}${bodyColor}` : char;

			if (isClosing) {
				closeChar = undefined;
			} else if (openCloseChar !== undefined && closeChar === undefined) {
				closeChar = openCloseChar;
			} else if (closeChar === undefined && DIALOGUE_CLOSE_CHARS.has(char)) {
				closeChar = undefined;
			}

			index += char.length;
		}

		return result;
	});
}

class AssistantTextMarkdown extends Markdown {
	private sourceText: string;
	private renderedSourceText?: string;
	private renderedTransformVersion = -1;

	constructor(...args: ConstructorParameters<typeof Markdown>) {
		super(...args);
		this.sourceText = args[0];
	}

	override setText(text: string): void {
		this.sourceText = text;
		this.renderedSourceText = undefined;
		super.setText(text);
	}

	override render(width: number): string[] {
		const settings = getAssistantReadingSettings();
		const transformVersion = getAssistantTextDisplayTransformsVersion();
		if (this.renderedSourceText !== this.sourceText || this.renderedTransformVersion !== transformVersion) {
			this.renderedSourceText = this.sourceText;
			this.renderedTransformVersion = transformVersion;
			super.setText(applyAssistantTextDisplayTransforms(this.sourceText));
		}
		const configuredWidth = settings.textWidth;
		const contentWidth =
			configuredWidth && width > configuredWidth
				? Math.max(MIN_ASSISTANT_TEXT_WIDTH, Math.min(configuredWidth, width))
				: width;
		const leftPad = contentWidth < width ? Math.floor((width - contentWidth) / 2) : 0;
		const lines = applyAssistantRenderedLineTransforms(super.render(contentWidth));
		const styledLines = settings.dialogueHighlight ? applyDialogueColor(lines) : lines;
		return styledLines.map((line) => indentLine(line, leftPad).trimEnd());
	}
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages have no background, so avoid Markdown padding around prose.
				this.contentContainer.addChild(
					new AssistantTextMarkdown(content.text.trim(), 0, 0, this.markdownTheme, {
						color: (text: string) => theme.fg("text", text),
					}),
				);
			} else if (content.type === "thinking" && content.thinking.trim()) {
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Show static thinking label when hidden
					this.contentContainer.addChild(
						new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), 1, 0),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				} else {
					// Thinking traces in thinkingText color, italic
					this.contentContainer.addChild(
						new Markdown(content.thinking.trim(), 1, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						}),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				if (hasVisibleContent) {
					this.contentContainer.addChild(new Spacer(1));
				} else {
					this.contentContainer.addChild(new Spacer(1));
				}
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
			}
		}
	}
}
