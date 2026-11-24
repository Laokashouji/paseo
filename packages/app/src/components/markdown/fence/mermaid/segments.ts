import { fromMarkdown } from "mdast-util-from-markdown";
import type { Definition, RootContent } from "mdast";
import { INTERACTIVE_CARD_FENCE_LANGUAGE } from "@getpaseo/protocol/interactive-cards";

export interface CustomFenceSegment {
  kind: "markdown" | "mermaid" | "paseo-view";
  id: string;
  source: string;
  blockIndex?: number;
}

/** Native enriched-markdown has no fenced-block override. Split custom fences (mermaid / paseo-view). */
export function splitCustomFences(
  markdown: string,
  options?: { allowInteractiveCards?: boolean },
): CustomFenceSegment[] {
  const allowCards = options?.allowInteractiveCards === true;
  const hasMermaid = /mermaid/i.test(markdown);
  const hasCards = allowCards && markdown.toLowerCase().includes(INTERACTIVE_CARD_FENCE_LANGUAGE);
  if (!hasMermaid && !hasCards) return [{ kind: "markdown", id: "0", source: markdown }];

  const segments: CustomFenceSegment[] = [];
  const definitions = new Map<string, Definition>();
  let cursor = 0;
  let cardBlockIndex = 0;

  function visit(node: RootContent): void {
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node);
    const lang = node.type === "code" ? node.lang?.toLowerCase() : undefined;
    const isMermaid = lang === "mermaid";
    const isCard = allowCards && lang === INTERACTIVE_CARD_FENCE_LANGUAGE;
    if (node.type === "code" && (isMermaid || isCard) && node.position) {
      const start = node.position.start.offset!;
      const end = node.position.end.offset!;
      if (start > cursor)
        segments.push({
          kind: "markdown",
          id: String(segments.length),
          source: markdown.slice(cursor, start),
        });
      if (isCard) {
        segments.push({
          kind: "paseo-view",
          id: String(segments.length),
          source: node.value,
          blockIndex: cardBlockIndex,
        });
        cardBlockIndex += 1;
      } else {
        segments.push({ kind: "mermaid", id: String(segments.length), source: node.value });
      }
      cursor = end;
    } else if ("children" in node) node.children.forEach(visit);
  }

  const tree = fromMarkdown(markdown);
  tree.children.forEach(visit);
  if (cursor < markdown.length || segments.length === 0)
    segments.push({
      kind: "markdown",
      id: String(segments.length),
      source: markdown.slice(cursor),
    });

  // Prepend the document's first definitions after splitting, so fragment-local
  // duplicates cannot override them. Original source slices and fence offsets stay intact.
  if (segments.some((segment) => segment.kind !== "markdown")) {
    const referenceSource = [...definitions.values()]
      .map((node) => {
        const label = node.identifier.replace(/[\\[\]]/g, "\\$&");
        const url = node.url.replace(/[\\<>]/g, "\\$&");
        const title = node.title ? ` "${node.title.replace(/[\\"]/g, "\\$&")}"` : "";
        return `[${label}]: <${url}>${title}`;
      })
      .join("\n");
    if (referenceSource)
      for (const segment of segments) {
        if (segment.kind === "markdown") segment.source = `${referenceSource}\n\n${segment.source}`;
      }
  }
  return segments;
}

export function splitMermaidFences(markdown: string): CustomFenceSegment[] {
  return splitCustomFences(markdown, { allowInteractiveCards: false });
}
