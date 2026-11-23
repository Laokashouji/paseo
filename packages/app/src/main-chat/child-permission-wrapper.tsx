import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { extractMainChatPermissionRuleCandidate } from "@getpaseo/protocol/main-chat";
import { ArrowUpRight, ShieldCheck } from "lucide-react-native";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Theme } from "@/styles/theme";
import type { PendingPermission } from "@/types/shared";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import {
  ApprovalClarifySection,
  RuleSuggestionBanner,
  findMatchingRuleSuggestion,
} from "./approval-clarify";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";

const ThemedArrowIcon = withUnistyles(ArrowUpRight);
const ThemedShieldIcon = withUnistyles(ShieldCheck);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });

export interface ChildPermissionWrapperProps {
  serverId: string;
  mainAgentId: string;
  permission: PendingPermission;
  client: DaemonClient | null;
  sourceAgentId: string;
  sourceAgentTitle: string;
  sourceAgentCwd?: string | null;
  children: ReactNode;
}

/**
 * Wraps the native `PermissionRequestCard` when a child agent's pending permission is surfaced
 * inline at the bottom of the Main Chat stream so the user can approve it in place, optionally
 * remember a conservative supervisor auto-approval rule for similar requests, or jump to the child
 * session.
 */
export const ChildPermissionWrapper = memo(function ChildPermissionWrapper({
  serverId,
  mainAgentId,
  permission,
  client,
  sourceAgentId,
  sourceAgentTitle,
  sourceAgentCwd,
  children,
}: ChildPermissionWrapperProps) {
  const { t } = useTranslation();
  const addPermissionRule = useMainChatOverviewStore((state) => state.addPermissionRule);
  const overviewKey = overviewStoreKey(serverId, mainAgentId);
  const ruleSuggestions = useMainChatOverviewStore(
    (state) => state.overviewsByKey[overviewKey]?.ruleSuggestions,
  );
  const [remembering, setRemembering] = useState(false);
  const [resolvedSuggestionIds, setResolvedSuggestionIds] = useState<string[]>([]);

  const ruleCandidate = useMemo(
    () =>
      extractMainChatPermissionRuleCandidate({
        kind: permission.request.kind,
        name: permission.request.name,
        title: permission.request.title,
        input: permission.request.input ?? null,
      }),
    [permission.request],
  );

  const matchingSuggestion = useMemo(
    () =>
      findMatchingRuleSuggestion({
        suggestions: ruleSuggestions,
        resolvedIds: new Set(resolvedSuggestionIds),
        serverId,
        permissionToolName: permission.request.name ?? permission.request.title ?? null,
        ruleCandidate,
      }),
    [
      permission.request.name,
      permission.request.title,
      resolvedSuggestionIds,
      ruleCandidate,
      ruleSuggestions,
      serverId,
    ],
  );

  const handleRuleSuggestionResolved = useCallback(
    (_outcome: "granted" | "dismissed", suggestionId: string) => {
      setResolvedSuggestionIds((prev) =>
        prev.includes(suggestionId) ? prev : [...prev, suggestionId],
      );
    },
    [],
  );

  const handleOpenChild = useCallback(() => {
    navigateToAgent({ serverId, agentId: sourceAgentId });
  }, [serverId, sourceAgentId]);

  const handleApproveAndRemember = useCallback(() => {
    if (!client || !ruleCandidate || remembering) return;
    setRemembering(true);
    void (async () => {
      try {
        await addPermissionRule(
          serverId,
          mainAgentId,
          {
            toolName: ruleCandidate.toolName,
            commandPrefix: ruleCandidate.commandPrefix,
            cwd: sourceAgentCwd ?? null,
          },
          client,
        );
        await client.respondToPermissionAndWait(
          permission.agentId,
          permission.request.id,
          { behavior: "allow" },
          15000,
        );
      } catch (error) {
        console.error("[ChildPermissionWrapper] Failed to approve and remember rule:", error);
      } finally {
        setRemembering(false);
      }
    })();
  }, [
    addPermissionRule,
    client,
    mainAgentId,
    permission.agentId,
    permission.request.id,
    remembering,
    ruleCandidate,
    serverId,
    sourceAgentCwd,
  ]);

  return (
    <View style={styles.wrapper} testID={`main-chat-child-permission-${sourceAgentId}`}>
      <View style={styles.header}>
        <StatusBadge variant="warning" size="xs" label={t("mainChat.childPermissionBadge")} />
        <Text style={styles.title} numberOfLines={1}>
          {sourceAgentTitle}
        </Text>
        {ruleCandidate && client ? (
          <PressHighlight
            onPress={handleApproveAndRemember}
            disabled={remembering}
            style={styles.rememberButton}
            highlightStyle={styles.openButtonPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.permission.approveAndRemember")}
            testID={`main-chat-child-permission-remember-${permission.request.id}`}
          >
            <ThemedShieldIcon size={12} uniProps={successIconMapping} />
            <Text style={styles.rememberLabel}>{t("mainChat.permission.approveAndRemember")}</Text>
          </PressHighlight>
        ) : null}
        <PressHighlight
          onPress={handleOpenChild}
          style={styles.openButton}
          highlightStyle={styles.openButtonPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.openChildAgent")}
        >
          <Text style={styles.openLabel}>{t("mainChat.openChildAgent")}</Text>
          <ThemedArrowIcon size={12} uniProps={mutedIconMapping} />
        </PressHighlight>
      </View>
      {children}
      <ApprovalClarifySection
        serverId={serverId}
        mainAgentId={mainAgentId}
        agentId={permission.agentId}
        permissionRequestId={permission.request.id}
        client={client}
      />
      {matchingSuggestion ? (
        <RuleSuggestionBanner
          serverId={serverId}
          mainAgentId={mainAgentId}
          suggestion={matchingSuggestion}
          client={client}
          onResolved={handleRuleSuggestionResolved}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  wrapper: {
    gap: theme.spacing[1.5],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    flexWrap: "wrap",
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  rememberButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  rememberLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  openButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.md,
  },
  openButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  openLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
