import type {
  MainChatRuleDiagnostic,
  MainChatRuleDiagnosticKind,
  MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import type { StatusBadgeVariant } from "@/components/ui/status-badge";

export interface ZeroTokenDiagnosticBadgeDescriptor {
  kind: MainChatRuleDiagnosticKind;
  variant: StatusBadgeVariant;
  labelKey: string;
  patternKey: string | null;
  summary: string;
  detail: string | null;
  toolName: string | null;
  repeatCount: number | null;
  errorExcerpt: string | null;
  missingItems: readonly string[];
}

export function deriveZeroTokenDiagnosticBadge(
  diagnostic: MainChatRuleDiagnostic | null | undefined,
): ZeroTokenDiagnosticBadgeDescriptor | null {
  if (!diagnostic) return null;
  const variant: StatusBadgeVariant =
    diagnostic.severity === "critical" || diagnostic.kind === "tool_loop" ? "error" : "warning";
  return {
    kind: diagnostic.kind,
    variant,
    labelKey: `mainChat.zeroTokenRules.badges.${diagnostic.kind}`,
    patternKey: diagnostic.pattern
      ? `mainChat.zeroTokenRules.patterns.${diagnostic.pattern}`
      : null,
    summary: diagnostic.summary,
    detail: diagnostic.detail ?? null,
    toolName: diagnostic.toolName ?? null,
    repeatCount: diagnostic.repeatCount ?? null,
    errorExcerpt: diagnostic.errorExcerpt ?? null,
    missingItems: diagnostic.missingItems ?? [],
  };
}

/**
 * Failed-task 1-click fallback retry is STRICTLY limited to Main Chat managed tasks
 * in a failed/error state — NEVER exposed on user manual sessions or terminal tasks.
 */
export function canRetryManagedFailedTask(
  task: MainChatTaskRecord | null | undefined,
  isLiveFailed = false,
): boolean {
  if (!task || !task.id) return false;
  if (task.supersededByTaskId) return false;
  if (task.status === "completed" || task.status === "cancelled") return false;
  return task.status === "failed" || isLiveFailed;
}
