export type AssistantRenderedLineTransform = (lines: string[]) => string[];

const renderedLineTransforms = new Map<string, AssistantRenderedLineTransform>();

export function registerAssistantRenderedLineTransform(id: string, transform: AssistantRenderedLineTransform): void {
	renderedLineTransforms.set(id, transform);
}

export function applyAssistantRenderedLineTransforms(lines: string[]): string[] {
	let transformed = lines;
	for (const transform of renderedLineTransforms.values()) {
		try {
			transformed = transform(transformed);
		} catch {
			// Rendering hooks are optional extension behavior; one bad hook should not break message display.
		}
	}
	return transformed;
}
