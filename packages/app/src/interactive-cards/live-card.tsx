import { memo, useMemo, type ReactElement, type ReactNode } from "react";
import { Text, View } from "react-native";
import { Blocks, RefreshCw } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  isInteractiveCardToolName,
  validateInteractiveCardView,
} from "@getpaseo/protocol/interactive-cards";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Theme } from "@/styles/theme";
import { InteractiveCardShell } from "./card-shell";
import { InteractiveCardContext } from "./context";
import { getAgentCardsBucket, useInteractiveCardsStore } from "./store";

const ThemedRefreshIcon = withUnistyles(RefreshCw);
const ThemedCardIcon = withUnistyles(Blocks);
const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const extraMutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (
    "structuredContent" in obj &&
    obj.structuredContent &&
    typeof obj.structuredContent === "object" &&
    !Array.isArray(obj.structuredContent)
  ) {
    return obj.structuredContent as Record<string, unknown>;
  }
  return obj;
}

export interface InteractiveLiveCardProps {
  serverId: string;
  agentId: string;
  client: DaemonClient | null;
  interactive: boolean;
  workspaceRoot?: string;
  onOpenFilePath?: (filePath: string) => void;
  toolInput: unknown;
  toolOutput: unknown;
  toolStatus: string;
  error?: unknown;
  renderMarkdown?: (content: string) => ReactNode;
}

const InteractiveLiveCard = memo(function InteractiveLiveCard({
  serverId,
  agentId,
  client,
  interactive,
  workspaceRoot,
  onOpenFilePath,
  toolInput,
  toolOutput,
  toolStatus,
  error,
  renderMarkdown,
}: InteractiveLiveCardProps) {
  const { t } = useTranslation();
  const outputObj = useMemo(() => asRecord(toolOutput), [toolOutput]);
  const inputObj = useMemo(() => asRecord(toolInput), [toolInput]);

  const cardId = typeof outputObj?.id === "string" ? outputObj.id : null;
  const liveRecord = useInteractiveCardsStore((s) =>
    cardId && serverId && agentId
      ? (getAgentCardsBucket(serverId, agentId, s).views[cardId] ?? null)
      : null,
  );

  // Use live store version when available; fall back to tool input view while syncing/offline.
  const fallbackView = useMemo(() => {
    if (liveRecord) return liveRecord.view;
    if (!inputObj?.view) return null;
    const res = validateInteractiveCardView(inputObj.view);
    return res.ok ? res.view : null;
  }, [inputObj?.view, liveRecord]);

  const contextValue = useMemo(
    () => ({
      serverId,
      agentId,
      client,
      interactive: interactive && Boolean(cardId),
      workspaceRoot,
      onOpenFilePath,
    }),
    [agentId, cardId, client, interactive, onOpenFilePath, serverId, workspaceRoot],
  );

  if (toolStatus === "failed" || error || outputObj?.ok === false) {
    return (
      <View style={styles.quietRow} testID="interactive-live-card-error">
        <ThemedCardIcon size={13} uniProps={warningIconMapping} />
        <Text style={styles.quietText} numberOfLines={2}>
          {t("interactiveCards.liveCardFailed")}
        </Text>
      </View>
    );
  }

  if (!fallbackView) {
    return (
      <View style={styles.quietRow} testID="interactive-live-card-loading">
        <ThemedCardIcon size={13} uniProps={mutedIconMapping} />
        <Text style={styles.quietText}>{t("interactiveCards.generating")}</Text>
      </View>
    );
  }

  return (
    <InteractiveCardContext.Provider value={contextValue}>
      <InteractiveCardShell
        cardKey={cardId ?? "pending_live_card"}
        view={fallbackView}
        version={
          liveRecord?.version ?? (typeof outputObj?.version === "number" ? outputObj.version : 1)
        }
        live
        renderMarkdown={renderMarkdown}
      />
    </InteractiveCardContext.Provider>
  );
});

const InteractiveLiveCardQuietReceipt = memo(function InteractiveLiveCardQuietReceipt({
  kind,
  toolOutput,
}: {
  kind: "view_update" | "view_get";
  toolOutput: unknown;
}) {
  const { t } = useTranslation();
  const outputObj = useMemo(() => asRecord(toolOutput), [toolOutput]);
  const version = typeof outputObj?.version === "number" ? outputObj.version : null;

  let label: string;
  if (kind === "view_update") {
    label = version
      ? t("interactiveCards.updatedVersion", { version })
      : t("interactiveCards.updatedGeneric");
  } else {
    label = t("interactiveCards.readCard");
  }

  return (
    <View style={styles.quietRow} testID={`interactive-live-card-${kind}`}>
      <ThemedRefreshIcon size={12} uniProps={extraMutedIconMapping} />
      <Text style={styles.quietText}>{label}</Text>
    </View>
  );
});

export function renderInteractiveToolCard(input: {
  serverId: string;
  agentId: string;
  client: DaemonClient | null;
  interactive: boolean;
  workspaceRoot?: string;
  onOpenFilePath?: (filePath: string) => void;
  toolName: string;
  toolStatus: string;
  toolInput: unknown;
  toolOutput: unknown;
  error?: unknown;
  renderMarkdown?: (content: string) => ReactNode;
}): ReactElement | null {
  const toolKind = isInteractiveCardToolName(input.toolName);
  if (!toolKind) return null;

  if (toolKind === "view_show") {
    return (
      <InteractiveLiveCard
        serverId={input.serverId}
        agentId={input.agentId}
        client={input.client}
        interactive={input.interactive}
        workspaceRoot={input.workspaceRoot}
        onOpenFilePath={input.onOpenFilePath}
        toolInput={input.toolInput}
        toolOutput={input.toolOutput}
        toolStatus={input.toolStatus}
        error={input.error}
        renderMarkdown={input.renderMarkdown}
      />
    );
  }

  return <InteractiveLiveCardQuietReceipt kind={toolKind} toolOutput={input.toolOutput} />;
}

const styles = StyleSheet.create((theme) => ({
  quietRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  quietText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
}));
