import {
  expandMainChatPromptTemplate,
  promptTemplateHasArgPlaceholder,
  resolvePromptTemplateSlashInvocation,
  type MainChatPromptTemplate,
} from "@getpaseo/protocol/main-chat";
import type { SlashCommandRange } from "@/utils/agent-command-autocomplete";

export interface PromptSlashCommandEntry {
  name: string;
  aliases: readonly string[];
  argumentHint: string;
  description: string;
  template: MainChatPromptTemplate;
}

export function buildPromptSlashCommandEntries(
  templates: readonly MainChatPromptTemplate[],
): PromptSlashCommandEntry[] {
  return templates.map((template) => {
    const aliases = [template.title];
    if (template.description.trim()) {
      aliases.push(template.description.trim());
    }
    return {
      name: template.slug,
      aliases,
      argumentHint: template.argumentHint ?? "",
      description: template.description
        ? `${template.title} · ${template.description}`
        : template.title,
      template,
    };
  });
}

/**
 * Replaces the active `/query` range in composer text with the selected prompt template.
 * - If the template has no `{{arg}}` placeholder, inserts its expanded body directly.
 * - If there is trailing argument text after `/query` (e.g. inline edit), expands `{{arg}}` with it;
 *   otherwise inserts the full template body ready for in-place editing (instant search-and-insert).
 */
export function applyPromptTemplateAutocompleteReplacement(input: {
  text: string;
  command: SlashCommandRange | null;
  template: MainChatPromptTemplate;
}): string {
  const { text, command, template } = input;
  if (!command) {
    return promptTemplateHasArgPlaceholder(template.content)
      ? template.content
      : expandMainChatPromptTemplate(template.content, "");
  }

  const before = text.slice(0, command.start);
  const after = text.slice(command.end);
  const trimmedAfter = after.trim();

  if (trimmedAfter.length > 0 && promptTemplateHasArgPlaceholder(template.content)) {
    const expanded = expandMainChatPromptTemplate(template.content, trimmedAfter);
    return `${before}${expanded}`;
  }

  const inserted = promptTemplateHasArgPlaceholder(template.content)
    ? template.content
    : expandMainChatPromptTemplate(template.content, "");

  if (after.length === 0) {
    return `${before}${inserted}`;
  }
  const spacer = /^\s/.test(after) ? "" : " ";
  return `${before}${inserted}${spacer}${after}`;
}

/**
 * Expands a direct `/<slug> <args>` submission when it matches a prompt template.
 * Returns the original text unchanged when no template matches.
 */
export function expandPromptTemplateSubmissionText(input: {
  text: string;
  templates: readonly MainChatPromptTemplate[];
  hasAttachments?: boolean;
}): {
  text: string;
  matchedTemplate: MainChatPromptTemplate | null;
} {
  const resolved = resolvePromptTemplateSlashInvocation({
    text: input.text,
    templates: input.templates,
    hasAttachments: input.hasAttachments,
  });
  if (!resolved) {
    return { text: input.text, matchedTemplate: null };
  }
  return {
    text: resolved.expandedText,
    matchedTemplate: resolved.template,
  };
}
