import { createContext, useContext, type ReactNode } from "react";
import { Text } from "react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export interface InteractiveCardHostContextValue {
  serverId: string;
  agentId: string;
  client: DaemonClient | null;
  /** Full un-truncated assistant message text used to compute deterministic inline card keys. */
  messageText?: string;
  /** True while the assistant message is still streaming. */
  streaming?: boolean;
  /** False for archived conversations, read-only subagent views, or external docs. */
  interactive: boolean;
  /** True when already inside a card (prevents recursive nested cards inside `markdown` items). */
  insideCard?: boolean;
  workspaceRoot?: string;
  onOpenFilePath?: (filePath: string) => void;
}

export const InteractiveCardContext = createContext<InteractiveCardHostContextValue | null>(null);

export function useInteractiveCardHost(): InteractiveCardHostContextValue | null {
  return useContext(InteractiveCardContext);
}

export type CardMarkdownRendererFn = (content: string) => ReactNode;

const fallbackMarkdownRenderer: CardMarkdownRendererFn = (content) => (
  <Text selectable>{content}</Text>
);

export const CardMarkdownRendererContext =
  createContext<CardMarkdownRendererFn>(fallbackMarkdownRenderer);

export function useCardMarkdownRenderer(): CardMarkdownRendererFn {
  return useContext(CardMarkdownRendererContext);
}
