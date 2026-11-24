import { isAgentRunning } from "@getpaseo/protocol/agent-state-bucket";
import type { MainChatOverview, MainChatTaskRecord } from "@getpaseo/protocol/main-chat";
import equal from "fast-deep-equal";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useOptionalToast } from "@/contexts/toast-context";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export interface SessionLinkHostInfo {
  serverId: string;
  label?: string | null;
}
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { useOpenMainChatTaskTarget, type OpenMainChatTaskResult } from "./open-task-target";
import { useMainChatOverviewStore } from "./overview-store";

export const SESSION_LINK_PROTOCOL = "paseo://";
export const SESSION_LINK_MIN_PREFIX_LEN = 8;

export type ParsedMainChatSessionLink =
  | {
      kind: "agent";
      serverId: string | null;
      agentId: string;
      rawUrl: string;
    }
  | {
      kind: "task";
      taskId: string;
      rawUrl: string;
    };

export interface ResolvedSessionLinkTarget {
  serverId: string;
  agentId: string;
  workspaceId: string | null;
  title: string | null;
  taskId: string | null;
  hostLabel: string | null;
  status: string | null;
  workspaceLabel: string | null;
  cwd: string | null;
}

export type SessionLinkResolution =
  | {
      status: "exact";
      target: ResolvedSessionLinkTarget;
    }
  | {
      status: "prefix";
      target: ResolvedSessionLinkTarget;
    }
  | {
      status: "ambiguous";
      matches: ResolvedSessionLinkTarget[];
    }
  | {
      status: "pending";
      serverId: string | null;
      taskId?: string;
      reason: "hydrating" | "task_unstarted";
    }
  | {
      status: "not_found";
    };

export interface SessionLinkCandidate {
  serverId: string;
  agentId: string;
  workspaceId: string | null;
  title: string | null;
  taskId: string | null;
  hostLabel: string | null;
  status: string | null;
  workspaceLabel: string | null;
  cwd: string | null;
}

export interface SessionLinkTaskCandidate {
  taskId: string;
  serverId: string;
  agentId: string | null;
  workspaceId: string | null;
  title: string | null;
  hostLabel: string | null;
  status: string | null;
  workspaceLabel: string | null;
  cwd: string | null;
}

export interface SessionLinkResolutionContext {
  candidates: readonly SessionLinkCandidate[];
  tasks?: readonly SessionLinkTaskCandidate[];
  hydratedServerIds?: ReadonlySet<string>;
  knownServerIds?: ReadonlySet<string>;
  preferredServerId?: string | null;
}

function safeDecodeSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment).trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    const trimmed = segment.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}

/**
 * Parses explicit Paseo session links (`paseo://agent/<serverId>/<agentId>`,
 * `paseo://agent/<agentId>`, `paseo://task/<taskId>`).
 * Returns `null` for plain text, book titles, or non-session URLs.
 */
export function parseMainChatSessionLink(rawUrl: string): ParsedMainChatSessionLink | null {
  const trimmed = rawUrl.trim();
  if (trimmed.length <= SESSION_LINK_PROTOCOL.length) return null;
  if (
    !trimmed.slice(0, SESSION_LINK_PROTOCOL.length).toLowerCase().startsWith(SESSION_LINK_PROTOCOL)
  ) {
    return null;
  }

  const remainder = trimmed.slice(SESSION_LINK_PROTOCOL.length);
  const withoutFragment = remainder.split(/[?#]/, 1)[0] ?? "";
  const cleaned = withoutFragment.replace(/\/+$/, "");
  if (!cleaned) return null;

  const rawSegments = cleaned.split("/");
  if (rawSegments.some((segment) => segment.length === 0)) {
    return null;
  }

  const kind = rawSegments[0]?.toLowerCase();
  if (kind === "agent") {
    if (rawSegments.length === 2) {
      const agentId = safeDecodeSegment(rawSegments[1]!);
      if (!agentId) return null;
      return {
        kind: "agent",
        serverId: null,
        agentId,
        rawUrl: trimmed,
      };
    }
    if (rawSegments.length === 3) {
      const serverId = safeDecodeSegment(rawSegments[1]!);
      const agentId = safeDecodeSegment(rawSegments[2]!);
      if (!serverId || !agentId) return null;
      return {
        kind: "agent",
        serverId,
        agentId,
        rawUrl: trimmed,
      };
    }
    return null;
  }

  if (kind === "task") {
    if (rawSegments.length === 2) {
      const taskId = safeDecodeSegment(rawSegments[1]!);
      if (!taskId) return null;
      return {
        kind: "task",
        taskId,
        rawUrl: trimmed,
      };
    }
    return null;
  }

  return null;
}

export function isMainChatSessionLink(rawUrl: string): boolean {
  return parseMainChatSessionLink(rawUrl) !== null;
}

function basenameOfPath(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const trimmed = cwd.replace(/[\\/]+$/, "").trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function toTarget(candidate: SessionLinkCandidate): ResolvedSessionLinkTarget {
  return {
    serverId: candidate.serverId,
    agentId: candidate.agentId,
    workspaceId: candidate.workspaceId,
    title: candidate.title,
    taskId: candidate.taskId,
    hostLabel: candidate.hostLabel,
    status: candidate.status,
    workspaceLabel: candidate.workspaceLabel,
    cwd: candidate.cwd,
  };
}

function hasPendingHydration(
  serverId: string | null,
  hydratedServerIds?: ReadonlySet<string>,
  knownServerIds?: ReadonlySet<string>,
): boolean {
  if (!knownServerIds || knownServerIds.size === 0) return false;
  if (serverId) {
    if (hydratedServerIds?.has(serverId)) return false;
    // Target server is known and not hydrated yet, or other known hosts are still syncing.
    if (knownServerIds.has(serverId)) return true;
    for (const knownId of knownServerIds) {
      if (!hydratedServerIds?.has(knownId)) return true;
    }
    return false;
  }
  for (const knownId of knownServerIds) {
    if (!hydratedServerIds?.has(knownId)) return true;
  }
  return false;
}

function pickFromMatches(
  matches: readonly SessionLinkCandidate[],
  status: "exact" | "prefix",
  preferredServerId?: string | null,
): SessionLinkResolution {
  if (matches.length === 1) {
    return { status, target: toTarget(matches[0]!) };
  }
  if (preferredServerId) {
    const preferred = matches.filter((entry) => entry.serverId === preferredServerId);
    if (preferred.length === 1) {
      return { status, target: toTarget(preferred[0]!) };
    }
  }
  return {
    status: "ambiguous",
    matches: matches.map(toTarget),
  };
}

function resolveTaskRecordTarget(
  task: SessionLinkTaskCandidate,
  candidates: readonly SessionLinkCandidate[],
): ResolvedSessionLinkTarget | null {
  if (!task.agentId) return null;
  const matched =
    candidates.find(
      (entry) => entry.serverId === task.serverId && entry.agentId === task.agentId,
    ) ?? candidates.find((entry) => entry.agentId === task.agentId);

  if (matched) {
    return {
      ...toTarget(matched),
      taskId: matched.taskId ?? task.taskId,
      title: matched.title || task.title,
      workspaceId: matched.workspaceId ?? task.workspaceId,
      hostLabel: matched.hostLabel ?? task.hostLabel,
      workspaceLabel: matched.workspaceLabel ?? task.workspaceLabel,
      cwd: matched.cwd ?? task.cwd,
    };
  }

  return {
    serverId: task.serverId,
    agentId: task.agentId,
    workspaceId: task.workspaceId,
    title: task.title,
    taskId: task.taskId,
    hostLabel: task.hostLabel,
    status: task.status,
    workspaceLabel: task.workspaceLabel,
    cwd: task.cwd,
  };
}

function pickTaskTargets(
  matchedTasks: readonly SessionLinkTaskCandidate[],
  candidates: readonly SessionLinkCandidate[],
  status: "exact" | "prefix",
  preferredServerId?: string | null,
): SessionLinkResolution {
  const targets = matchedTasks
    .map((task) => resolveTaskRecordTarget(task, candidates))
    .filter((item): item is ResolvedSessionLinkTarget => item !== null);
  if (targets.length === 1) {
    return { status, target: targets[0]! };
  }
  if (targets.length > 1) {
    const preferred = preferredServerId
      ? targets.filter((item) => item.serverId === preferredServerId)
      : [];
    if (preferred.length === 1) {
      return { status, target: preferred[0]! };
    }
    return { status: "ambiguous", matches: targets };
  }
  const first = matchedTasks[0]!;
  return {
    status: "pending",
    serverId: first.serverId,
    taskId: first.taskId,
    reason: "task_unstarted",
  };
}

function resolveTaskSessionLink(
  parsed: Extract<ParsedMainChatSessionLink, { kind: "task" }>,
  context: SessionLinkResolutionContext,
): SessionLinkResolution {
  const { candidates, tasks = [], hydratedServerIds, knownServerIds, preferredServerId } = context;
  const query = parsed.taskId;
  const exactTasks = tasks.filter((task) => task.taskId === query);
  if (exactTasks.length > 0) {
    return pickTaskTargets(exactTasks, candidates, "exact", preferredServerId);
  }

  if (query.length >= SESSION_LINK_MIN_PREFIX_LEN) {
    const queryLower = query.toLowerCase();
    const prefixTasks = tasks.filter((task) => task.taskId.toLowerCase().startsWith(queryLower));
    if (prefixTasks.length > 0) {
      return pickTaskTargets(prefixTasks, candidates, "prefix", preferredServerId);
    }
  }

  if (hasPendingHydration(null, hydratedServerIds, knownServerIds)) {
    return {
      status: "pending",
      serverId: null,
      taskId: query,
      reason: "hydrating",
    };
  }
  return { status: "not_found" };
}

function resolveAgentSessionLink(
  parsed: Extract<ParsedMainChatSessionLink, { kind: "agent" }>,
  context: SessionLinkResolutionContext,
): SessionLinkResolution {
  const { candidates, hydratedServerIds, knownServerIds, preferredServerId } = context;
  const scopedCandidates = parsed.serverId
    ? candidates.filter((entry) => entry.serverId === parsed.serverId)
    : candidates;
  const disambiguateServerId = parsed.serverId ? null : preferredServerId;

  const exactMatches = scopedCandidates.filter((entry) => entry.agentId === parsed.agentId);
  if (exactMatches.length > 0) {
    return pickFromMatches(exactMatches, "exact", disambiguateServerId);
  }

  if (parsed.agentId.length >= SESSION_LINK_MIN_PREFIX_LEN) {
    const queryLower = parsed.agentId.toLowerCase();
    const prefixMatches = scopedCandidates.filter((entry) =>
      entry.agentId.toLowerCase().startsWith(queryLower),
    );
    if (prefixMatches.length > 0) {
      return pickFromMatches(prefixMatches, "prefix", disambiguateServerId);
    }
  }

  if (hasPendingHydration(parsed.serverId, hydratedServerIds, knownServerIds)) {
    return {
      status: "pending",
      serverId: parsed.serverId,
      reason: "hydrating",
    };
  }

  return { status: "not_found" };
}

/**
 * Five-state session link resolver aligned with Persona's 8-char short-ID prefix matching:
 * `exact` | `prefix` | `ambiguous` | `pending` | `not_found`.
 */
export function resolveMainChatSessionLink(
  parsed: ParsedMainChatSessionLink,
  context: SessionLinkResolutionContext,
): SessionLinkResolution {
  if (parsed.kind === "task") {
    return resolveTaskSessionLink(parsed, context);
  }
  return resolveAgentSessionLink(parsed, context);
}

type SessionStoreState = ReturnType<typeof useSessionStore.getState>;
type HostSessionEntry = SessionStoreState["sessions"][string];

function resolvePrimaryTaskAgentId(task: MainChatTaskRecord): string | null {
  if (task.activeAgentId?.trim()) return task.activeAgentId.trim();
  const last = task.agentIds.at(-1);
  return last?.trim() || null;
}

function deriveAgentLinkStatus(agent: {
  status: Parameters<typeof isAgentRunning>[0]["status"];
  backgroundWork?: Parameters<typeof isAgentRunning>[0]["backgroundWork"];
  requiresAttention?: boolean;
  attentionReason?: string | null;
}): string | null {
  if (agent.requiresAttention && agent.attentionReason === "permission") {
    return "needs_you";
  }
  const running = isAgentRunning({
    status: agent.status,
    backgroundWork: agent.backgroundWork,
  });
  if (running && agent.status !== "error") {
    return "running";
  }
  return agent.status ?? null;
}

function toTaskCandidate(
  task: MainChatTaskRecord,
  serverId: string,
  primaryAgentId: string | null,
  hostLabels: ReadonlyMap<string, string>,
): SessionLinkTaskCandidate {
  return {
    taskId: task.id,
    serverId,
    agentId: primaryAgentId,
    workspaceId: task.workspaceId ?? null,
    title: task.title?.trim() || null,
    hostLabel: task.hostLabel?.trim() || hostLabels.get(serverId) || null,
    status: task.status ?? null,
    workspaceLabel: basenameOfPath(task.cwd),
    cwd: task.cwd ?? null,
  };
}

function indexTaskAgents(
  task: MainChatTaskRecord,
  serverId: string,
  primaryAgentId: string | null,
  taskByAgentKey: Map<string, MainChatTaskRecord>,
): void {
  if (primaryAgentId) {
    taskByAgentKey.set(`${serverId}:${primaryAgentId}`, task);
  }
  for (const linkedAgentId of task.agentIds) {
    const trimmed = linkedAgentId.trim();
    if (trimmed) {
      taskByAgentKey.set(`${serverId}:${trimmed}`, task);
    }
  }
}

function collectOverviewTaskCandidates(
  overviewsByKey: Readonly<Record<string, MainChatOverview | undefined>>,
  hostLabels: ReadonlyMap<string, string>,
): {
  taskCandidates: SessionLinkTaskCandidate[];
  taskByAgentKey: Map<string, MainChatTaskRecord>;
} {
  const taskCandidates: SessionLinkTaskCandidate[] = [];
  const taskByAgentKey = new Map<string, MainChatTaskRecord>();
  const seenTaskKeys = new Set<string>();

  for (const [overviewKey, overview] of Object.entries(overviewsByKey)) {
    if (!overview) continue;
    const fallbackServerId = overviewKey.split(":", 1)[0] ?? "";
    for (const task of overview.tasks ?? []) {
      const serverId = task.serverId?.trim() || fallbackServerId;
      if (!serverId) continue;
      const primaryAgentId = resolvePrimaryTaskAgentId(task);
      const taskKey = `${serverId}:${task.id}`;
      if (!seenTaskKeys.has(taskKey)) {
        seenTaskKeys.add(taskKey);
        taskCandidates.push(toTaskCandidate(task, serverId, primaryAgentId, hostLabels));
      }
      indexTaskAgents(task, serverId, primaryAgentId, taskByAgentKey);
    }
  }

  return { taskCandidates, taskByAgentKey };
}

function buildWorkspaceNameMap(session: HostSessionEntry): Map<string, string> {
  const workspaceNameById = new Map<string, string>();
  for (const workspace of session.workspaces.values()) {
    const label =
      workspace.projectCustomName?.trim() ||
      workspace.projectDisplayName?.trim() ||
      basenameOfPath(workspace.workspaceDirectory);
    if (label) workspaceNameById.set(workspace.id, label);
  }
  return workspaceNameById;
}

function buildCandidateFromAgentRecord(input: {
  serverId: string;
  id: string;
  workspaceId?: string | null;
  title?: string | null;
  cwd?: string | null;
  status: string | null;
  hostLabel: string | null;
  task: MainChatTaskRecord | null;
  workspaceNameById: ReadonlyMap<string, string>;
}): SessionLinkCandidate {
  const { serverId, id, workspaceId, title, cwd, status, hostLabel, task, workspaceNameById } =
    input;
  const workspaceLabel =
    (workspaceId ? workspaceNameById.get(workspaceId) : null) ?? basenameOfPath(cwd);
  return {
    serverId,
    agentId: id,
    workspaceId: workspaceId ?? null,
    title: title?.trim() || task?.title?.trim() || basenameOfPath(cwd),
    taskId: task?.id ?? null,
    hostLabel,
    status,
    workspaceLabel,
    cwd: cwd ?? null,
  };
}

function collectHostSessionCandidates(input: {
  serverId: string;
  session: HostSessionEntry;
  hostLabel: string | null;
  taskByAgentKey: ReadonlyMap<string, MainChatTaskRecord>;
  candidateByKey: Map<string, SessionLinkCandidate>;
}): void {
  const { serverId, session, hostLabel, taskByAgentKey, candidateByKey } = input;
  const workspaceNameById = buildWorkspaceNameMap(session);

  for (const agent of session.agents.values()) {
    const key = `${serverId}:${agent.id}`;
    candidateByKey.set(
      key,
      buildCandidateFromAgentRecord({
        serverId,
        id: agent.id,
        workspaceId: agent.workspaceId,
        title: agent.title,
        cwd: agent.cwd,
        status: deriveAgentLinkStatus(agent),
        hostLabel,
        task: taskByAgentKey.get(key) ?? null,
        workspaceNameById,
      }),
    );
  }

  for (const detail of session.agentDetails.values()) {
    const key = `${serverId}:${detail.id}`;
    if (candidateByKey.has(key)) continue;
    candidateByKey.set(
      key,
      buildCandidateFromAgentRecord({
        serverId,
        id: detail.id,
        workspaceId: detail.workspaceId,
        title: detail.title,
        cwd: detail.cwd,
        status: detail.status ?? null,
        hostLabel,
        task: taskByAgentKey.get(key) ?? null,
        workspaceNameById,
      }),
    );
  }
}

export function collectSessionLinkResolutionContext(input: {
  sessions: SessionStoreState["sessions"];
  overviewsByKey: Readonly<Record<string, MainChatOverview | undefined>>;
  hosts?: readonly SessionLinkHostInfo[];
  preferredServerId?: string | null;
}): SessionLinkResolutionContext {
  const hostLabels = new Map<string, string>();
  const knownServerIds = new Set<string>();
  const hydratedServerIds = new Set<string>();

  for (const host of input.hosts ?? []) {
    knownServerIds.add(host.serverId);
    if (host.label?.trim()) {
      hostLabels.set(host.serverId, host.label.trim());
    }
  }

  const { taskCandidates, taskByAgentKey } = collectOverviewTaskCandidates(
    input.overviewsByKey,
    hostLabels,
  );
  const candidateByKey = new Map<string, SessionLinkCandidate>();

  for (const [serverId, session] of Object.entries(input.sessions)) {
    knownServerIds.add(serverId);
    if (session.hasHydratedAgents) {
      hydratedServerIds.add(serverId);
    }
    const hostLabel = hostLabels.get(serverId) ?? session.serverInfo?.hostname?.trim() ?? null;
    collectHostSessionCandidates({
      serverId,
      session,
      hostLabel,
      taskByAgentKey,
      candidateByKey,
    });
  }

  for (const task of taskCandidates) {
    if (!task.agentId) continue;
    const key = `${task.serverId}:${task.agentId}`;
    if (candidateByKey.has(key)) continue;
    candidateByKey.set(key, {
      serverId: task.serverId,
      agentId: task.agentId,
      workspaceId: task.workspaceId,
      title: task.title,
      taskId: task.taskId,
      hostLabel: task.hostLabel,
      status: task.status,
      workspaceLabel: task.workspaceLabel,
      cwd: task.cwd,
    });
  }

  return {
    candidates: [...candidateByKey.values()],
    tasks: taskCandidates,
    hydratedServerIds,
    knownServerIds,
    preferredServerId: input.preferredServerId ?? null,
  };
}

export function resolveMainChatSessionLinkFromStore(
  rawUrl: string,
  options?: {
    hosts?: readonly SessionLinkHostInfo[];
    preferredServerId?: string | null;
  },
): SessionLinkResolution | null {
  const parsed = parseMainChatSessionLink(rawUrl);
  if (!parsed) return null;
  const context = collectSessionLinkResolutionContext({
    sessions: useSessionStore.getState().sessions,
    overviewsByKey: useMainChatOverviewStore.getState().overviewsByKey,
    hosts: options?.hosts,
    preferredServerId: options?.preferredServerId,
  });
  return resolveMainChatSessionLink(parsed, context);
}

/**
 * Converts a resolved session link target into an in-app web route URL so `<a href>`
 * supports Cmd/Ctrl/middle-click new-tab opens without ever exposing `paseo://` to
 * browser external-protocol handlers.
 */
export function buildMainChatSessionWebHref(target: ResolvedSessionLinkTarget): string {
  return buildHostAgentDetailRoute(
    target.serverId,
    target.agentId,
    target.workspaceId ?? undefined,
  );
}

function formatStatusLabel(
  status: string | null | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (!status) return null;
  switch (status.toLowerCase()) {
    case "running":
    case "in_progress":
    case "working":
      return t("mainChat.sessionLink.statusRunning");
    case "initializing":
    case "starting":
      return t("mainChat.sessionLink.statusInitializing");
    case "needs_you":
    case "blocked_user":
    case "waiting":
      return t("mainChat.sessionLink.statusNeedsYou");
    case "idle":
    case "completed":
      return t("mainChat.sessionLink.statusIdle");
    case "error":
    case "failed":
      return t("mainChat.sessionLink.statusError");
    case "closed":
      return t("mainChat.sessionLink.statusClosed");
    default:
      return status;
  }
}

export function formatSessionLinkTooltip(
  resolution: SessionLinkResolution | null,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (!resolution) return null;
  if (resolution.status === "exact" || resolution.status === "prefix") {
    const { target } = resolution;
    const statusLabel = formatStatusLabel(target.status, t);
    const parts = [target.hostLabel, statusLabel, target.workspaceLabel].filter(
      (part): part is string => Boolean(part && part.trim().length > 0),
    );
    if (parts.length > 0) return parts.join(" · ");
    return target.title ?? target.agentId;
  }
  if (resolution.status === "ambiguous") {
    return t("mainChat.sessionLink.ambiguous", { count: resolution.matches.length });
  }
  if (resolution.status === "pending") {
    return resolution.reason === "task_unstarted"
      ? t("mainChat.sessionLink.pendingTaskUnstarted")
      : t("mainChat.sessionLink.pendingHydrating");
  }
  return t("mainChat.sessionLink.notFound");
}

export interface SessionLinkPresentationMeta {
  parsed: ParsedMainChatSessionLink;
  resolution: SessionLinkResolution;
  webHref: string | null;
  tooltip: string | null;
}

/**
 * Reactive selector hook for rendering a parsed `paseo://` session link's Web `href`
 * and hover tooltip (`host · status · workspace`), guarded with `fast-deep-equal`.
 */
export function useMainChatSessionLinkMeta(
  parsed: ParsedMainChatSessionLink,
  preferredServerId?: string | null,
): SessionLinkPresentationMeta {
  const { t } = useTranslation();
  const hosts = useHosts();
  const overviewsByKey = useMainChatOverviewStore((state) => state.overviewsByKey);

  const resolution = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) => {
        const context = collectSessionLinkResolutionContext({
          sessions: state.sessions,
          overviewsByKey,
          hosts,
          preferredServerId,
        });
        return resolveMainChatSessionLink(parsed, context);
      },
      [hosts, overviewsByKey, parsed, preferredServerId],
    ),
    equal,
  );

  return useMemo(() => {
    const webHref =
      resolution.status === "exact" || resolution.status === "prefix"
        ? buildMainChatSessionWebHref(resolution.target)
        : null;
    const tooltip = formatSessionLinkTooltip(resolution, t);
    return {
      parsed,
      resolution,
      webHref,
      tooltip,
    };
  }, [parsed, resolution, t]);
}

export type OpenMainChatSessionLinkResult =
  | {
      opened: true;
      mode: OpenMainChatTaskResult;
      resolution: Extract<SessionLinkResolution, { status: "exact" | "prefix" }>;
    }
  | { opened: false; resolution: SessionLinkResolution | null };

/**
 * Unified hook to open a `paseo://agent/...` or `paseo://task/...` link:
 * - Resolves exact / 8-char prefix across hosts
 * - Reuses `useOpenMainChatTaskTarget` (right drawer on wide `/main`, full-page + CameFrom on compact)
 * - Emits non-blocking toast for `not_found`, `ambiguous`, or `pending`
 */
export function useMainChatSessionLinkOpener(preferredServerId?: string | null) {
  const { t } = useTranslation();
  const toast = useOptionalToast();
  const hosts = useHosts();
  const openTaskTarget = useOpenMainChatTaskTarget();

  return useCallback(
    (rawUrl: string): OpenMainChatSessionLinkResult => {
      const resolution = resolveMainChatSessionLinkFromStore(rawUrl, {
        hosts,
        preferredServerId,
      });
      if (!resolution) {
        return { opened: false, resolution: null };
      }

      if (resolution.status === "exact" || resolution.status === "prefix") {
        const { target } = resolution;
        const mode = openTaskTarget({
          serverId: target.serverId,
          agentId: target.agentId,
          workspaceId: target.workspaceId,
          title: target.title,
          taskId: target.taskId,
        });
        return { opened: true, mode, resolution };
      }

      if (resolution.status === "ambiguous") {
        toast?.show(t("mainChat.sessionLink.ambiguous", { count: resolution.matches.length }));
      } else if (resolution.status === "pending") {
        toast?.show(
          resolution.reason === "task_unstarted"
            ? t("mainChat.sessionLink.pendingTaskUnstarted")
            : t("mainChat.sessionLink.pendingHydrating"),
        );
      } else {
        toast?.error(t("mainChat.sessionLink.notFound"));
      }

      return { opened: false, resolution };
    },
    [hosts, openTaskTarget, preferredServerId, t, toast],
  );
}
