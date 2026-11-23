import path from "node:path";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import {
  getMainChatTaskMetaFromLabels,
  isMainChatLabels,
  resolveActiveMainChatStylePreset,
  type MainChatDecisionRecord,
  type MainChatPlanRecord,
  type MainChatSessionTriage,
  type MainChatSettings,
} from "@getpaseo/protocol/main-chat";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import { isMainChatConversationLabels } from "./conversations.js";
import type { MainChatStore } from "./store.js";

export const MAX_SNAPSHOT_CHARS = 6_000;
export const SNAPSHOT_CACHE_TTL_MS = 45_000;
export const SNAPSHOT_FOREGROUND_TIMEOUT_MS = 1_500;
export const SNAPSHOT_STALE_FALLBACK_MAX_AGE_MS = 30 * 60 * 1_000;
export const MAX_INLINE_RUNNING_ITEMS = 3;

const MAX_SINGLE_LINE_CHARS = 280;
const GLOBAL_CACHE_KEY = "__global__";

export interface FleetSessionSnapshotItem {
  agentId: string;
  workspaceId: string | null;
  title: string;
  cwd: string;
  projectName: string;
  managedByMainChat: boolean;
  lifecycle: string;
  requiresAttention: boolean;
  attentionReason: string | null;
  pendingPermissionLabels: string[];
  lastError: string | null;
  updatedAtIso: string;
  triage: MainChatSessionTriage | null;
}

export interface FleetSnapshotSummary {
  totalActive: number;
  needsYou: FleetSessionSnapshotItem[];
  problematic: FleetSessionSnapshotItem[];
  running: FleetSessionSnapshotItem[];
  attentionDone: FleetSessionSnapshotItem[];
  idleOther: FleetSessionSnapshotItem[];
}

export interface CollectFleetOptions {
  bypassCache?: boolean;
}

export interface BuildTurnContextOptions {
  forceFull?: boolean;
  /** Enforces the 1.5s non-blocking refresh timeout with stale-cache fallback. */
  foreground?: boolean;
  /** Optional one-shot handoff summary prepended on the first turn of a new main-chat session. */
  handoffSummary?: string | null;
}

export interface MainChatContextSnapshotBuilder {
  collectFleet(
    mainAgentId?: string | null,
    options?: CollectFleetOptions,
  ): Promise<FleetSnapshotSummary>;
  buildTurnContext(mainAgentId: string, options?: BuildTurnContextOptions): Promise<string>;
  resetDelta(mainAgentId: string): void;
  invalidateCache(mainAgentId?: string | null): void;
}

interface SnapshotRow {
  id: string;
  text: string;
  shortLabel: string;
}

interface LogicalSection {
  key: string;
  title: string;
  rows: SnapshotRow[];
}

interface CachedFleetEntry {
  summary: FleetSnapshotSummary;
  collectedAtMs: number;
  liveFingerprint: string;
  invalidated: boolean;
}

function emptyFleetSummary(): FleetSnapshotSummary {
  return {
    totalActive: 0,
    needsYou: [],
    problematic: [],
    running: [],
    attentionDone: [],
    idleOther: [],
  };
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

function truncateMultiline(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

function basenameOf(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return path.basename(trimmed) || trimmed;
}

function summarizePermission(permission: {
  name?: string | null;
  title?: string | null;
  description?: string | null;
}): string {
  const label = permission.title?.trim() || permission.name?.trim() || "待审批请求";
  const desc = permission.description?.trim();
  if (desc && desc !== label) {
    return `${label}（${truncateText(desc, 60)}）`;
  }
  return label;
}

function formatDetailedRow(item: FleetSessionSnapshotItem): SnapshotRow {
  const tag = item.managedByMainChat ? "管家派发" : "手动会话";
  const shortLabel = `「${truncateText(item.title, 40)}」[${item.projectName} · id=${item.agentId}]`;
  const base = `「${truncateText(item.title, 48)}」[${tag} · ${item.projectName} · id=${item.agentId}]`;
  const parts: string[] = [];
  if (item.pendingPermissionLabels.length > 0) {
    parts.push(`待审批：${item.pendingPermissionLabels.slice(0, 2).join("；")}`);
  }
  if (item.triage) {
    const wait = item.triage.waitReason
      ? `（卡点：${truncateText(item.triage.waitReason, 80)}）`
      : "";
    const next = item.triage.suggestedAction
      ? `；建议：${truncateText(item.triage.suggestedAction, 60)}`
      : "";
    parts.push(`${truncateText(item.triage.summary, 100)}${wait}${next}`);
  } else if (item.lastError) {
    parts.push(`报错：${truncateText(item.lastError, 110)}`);
  } else if (item.attentionReason) {
    parts.push(`状态：${item.attentionReason}`);
  }
  const raw = parts.length > 0 ? `${base}：${parts.join(" | ")}` : base;
  return {
    id: item.agentId,
    text: truncateText(raw, MAX_SINGLE_LINE_CHARS),
    shortLabel,
  };
}

function formatCompactWorkingRow(item: FleetSessionSnapshotItem): SnapshotRow {
  const tag = item.managedByMainChat ? "管家" : "手动";
  const shortLabel = `「${truncateText(item.title, 36)}」[${item.projectName} · id=${item.agentId}]`;
  const text = `「${truncateText(item.title, 36)}」[${tag} · ${item.projectName} · id=${item.agentId}]`;
  return {
    id: item.agentId,
    text: truncateText(text, MAX_SINGLE_LINE_CHARS),
    shortLabel,
  };
}

function formatStyleSummary(settings: MainChatSettings): string {
  const activePreset = resolveActiveMainChatStylePreset(settings);
  const baseLabel =
    settings.style === "proactive"
      ? "激进模式（B · 主动代答与催促）"
      : "保守模式（A · 仅汇报建议）";
  const styleLabel =
    activePreset.kind === "custom" && activePreset.name
      ? `自定义预设「${activePreset.name}」（基于${settings.style === "proactive" ? "激进" : "保守"}）`
      : baseLabel;
  const extras: string[] = [];
  if (settings.capabilities.autoContinueManualErrors) extras.push("瞬时报错自动续跑");
  if (settings.capabilities.autoDelegateManualQuestions) extras.push("允许低风险技术问题代答");
  if (settings.capabilities.autoNudgeManualStalled) extras.push("允许催促停滞/空转手动会话");
  return `${styleLabel}${extras.length > 0 ? `；当前启用：${extras.join("、")}` : ""}`;
}

function formatNowLocal(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} 周${weekdays[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function buildPlanRows(plans: readonly MainChatPlanRecord[]): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  for (const plan of plans) {
    if (plan.status === "cancelled") continue;
    const titles = plan.tasks.map((task) => truncateText(task.title, 28)).join("、");
    if (plan.status === "open") {
      const shortLabel = `待开始计划（${plan.id}）`;
      rows.push({
        id: `plan:${plan.id}`,
        text: truncateText(`待点击开始的计划（${plan.id}）：${titles}`, MAX_SINGLE_LINE_CHARS),
        shortLabel,
      });
      continue;
    }
    const failedCount = plan.tasks.filter((task) => task.startError && !task.agentId).length;
    const startedCount = plan.tasks.filter((task) => task.agentId).length;
    const statusText =
      failedCount > 0
        ? `已启动 ${startedCount}/${plan.tasks.length}（启动失败 ${failedCount}）`
        : `进行中 ${startedCount}/${plan.tasks.length}`;
    const shortLabel = `受控计划（${plan.id}）`;
    rows.push({
      id: `plan:${plan.id}`,
      text: truncateText(
        `受控计划（${plan.id} · ${statusText}）：${titles}`,
        MAX_SINGLE_LINE_CHARS,
      ),
      shortLabel,
    });
  }
  return rows;
}

function buildDecisionRows(openDecisions: readonly MainChatDecisionRecord[]): SnapshotRow[] {
  return openDecisions.map((decision) => ({
    id: `decision:${decision.id}`,
    text: truncateText(
      `待回答决策卡（${decision.id}）：${decision.title} — ${decision.question}`,
      MAX_SINGLE_LINE_CHARS,
    ),
    shortLabel: `决策卡「${truncateText(decision.title, 32)}」（${decision.id}）`,
  }));
}

function buildWorkingRows(running: readonly FleetSessionSnapshotItem[]): SnapshotRow[] {
  if (running.length === 0) return [];
  const inline = running.slice(0, MAX_INLINE_RUNNING_ITEMS).map(formatCompactWorkingRow);
  const foldedCount = running.length - inline.length;
  if (foldedCount > 0) {
    inline.push({
      id: "running:__folded__",
      text: `另有 ${foldedCount} 个任务正常运行中（可用 task_list 查看全部）`,
      shortLabel: `另有 ${foldedCount} 个运行中任务`,
    });
  }
  return inline;
}

function buildOtherIdleRows(idleOther: readonly FleetSessionSnapshotItem[]): SnapshotRow[] {
  if (idleOther.length === 0) return [];
  return [
    {
      id: "other:__count__",
      text: `另有 ${idleOther.length} 个空闲会话（可用 task_list 按需查看）`,
      shortLabel: `${idleOther.length} 个空闲会话`,
    },
  ];
}

function packSectionBlock(input: {
  heading: string;
  lines: Array<{ rendered: string; row?: SnapshotRow }>;
  remainingChars: number;
}): {
  block: string | null;
  includedRows: SnapshotRow[];
} {
  const { heading, lines, remainingChars } = input;
  if (lines.length === 0) {
    return { block: null, includedRows: [] };
  }

  const separatorReserve = 2; // "\n\n"
  const budget = remainingChars - separatorReserve;
  if (budget <= heading.length + 12) {
    return { block: null, includedRows: [] };
  }

  const keptLines: string[] = [];
  const includedRows: SnapshotRow[] = [];
  let used = heading.length;

  for (let index = 0; index < lines.length; index += 1) {
    const entry = lines[index]!;
    const remainingCountAfter = lines.length - (index + 1);
    const omissionNotice =
      remainingCountAfter > 0
        ? `\n- ...其余 ${remainingCountAfter} 项已省略（可用 task_list / get_agent_activity 查询）`
        : "";
    const candidateAdd = 1 + entry.rendered.length;
    if (used + candidateAdd + omissionNotice.length <= budget) {
      keptLines.push(entry.rendered);
      if (entry.row) includedRows.push(entry.row);
      used += candidateAdd;
      continue;
    }

    const omittedCount = lines.length - index;
    const notice = `- ...其余 ${omittedCount} 项已省略（可用 task_list / get_agent_activity 查询）`;
    if (used + 1 + notice.length <= budget) {
      keptLines.push(notice);
    }
    break;
  }

  if (keptLines.length === 0) {
    const compactNotice = `- 共 ${lines.length} 项超出快照预算已折叠（可用 task_list 查询）`;
    if (heading.length + 1 + compactNotice.length <= budget) {
      return {
        block: `${heading}\n${compactNotice}`,
        includedRows: [],
      };
    }
    return { block: null, includedRows: [] };
  }

  return {
    block: `${heading}\n${keptLines.join("\n")}`,
    includedRows,
  };
}

export function createMainChatContextSnapshotBuilder(deps: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  store: MainChatStore;
  collectMultiHostFleet?: (mainAgentId?: string | null) => Promise<FleetSnapshotSummary | null>;
  now?: () => number;
  cacheTtlMs?: number;
  foregroundTimeoutMs?: number;
  maxSnapshotChars?: number;
}): MainChatContextSnapshotBuilder {
  const getNowMs = deps.now ?? (() => Date.now());
  const cacheTtlMs = deps.cacheTtlMs ?? SNAPSHOT_CACHE_TTL_MS;
  const foregroundTimeoutMs = deps.foregroundTimeoutMs ?? SNAPSHOT_FOREGROUND_TIMEOUT_MS;
  const maxSnapshotChars = Math.max(400, deps.maxSnapshotChars ?? MAX_SNAPSHOT_CHARS);

  const lastRowsByMainAgent = new Map<string, Map<string, Map<string, SnapshotRow>>>();
  const cacheByKey = new Map<string, CachedFleetEntry>();
  const inFlightRefreshByKey = new Map<string, Promise<FleetSnapshotSummary>>();
  let cacheGeneration = 0;

  function toLiveItem(
    agent: ManagedAgent,
    mainAgentId: string | null | undefined,
  ): FleetSessionSnapshotItem {
    const parentId = getParentAgentIdFromLabels(agent.labels);
    const taskMeta = getMainChatTaskMetaFromLabels(agent.labels);
    const managedByMainChat = Boolean(
      (mainAgentId && parentId === mainAgentId) || (parentId && taskMeta?.planId),
    );
    const pendingPermissionLabels = Array.from(agent.pendingPermissions.values()).map((perm) =>
      summarizePermission(perm),
    );
    const title = agent.config.title?.trim() || basenameOf(agent.cwd);
    return {
      agentId: agent.id,
      workspaceId: agent.workspaceId ?? null,
      title,
      cwd: agent.cwd,
      projectName: basenameOf(agent.cwd),
      managedByMainChat,
      lifecycle: agent.lifecycle,
      requiresAttention: agent.attention.requiresAttention,
      attentionReason: agent.attention.requiresAttention ? agent.attention.attentionReason : null,
      pendingPermissionLabels,
      lastError: agent.lastError ?? null,
      updatedAtIso: agent.updatedAt.toISOString(),
      triage: deps.store.getTriage(agent.id),
    };
  }

  function toStoredItem(
    record: StoredAgentRecord,
    mainAgentId: string | null | undefined,
  ): FleetSessionSnapshotItem {
    const parentId = getParentAgentIdFromLabels(record.labels);
    const taskMeta = getMainChatTaskMetaFromLabels(record.labels);
    const managedByMainChat = Boolean(
      (mainAgentId && parentId === mainAgentId) || (parentId && taskMeta?.planId),
    );
    const title = record.title?.trim() || basenameOf(record.cwd);
    return {
      agentId: record.id,
      workspaceId: record.workspaceId ?? null,
      title,
      cwd: record.cwd,
      projectName: basenameOf(record.cwd),
      managedByMainChat,
      lifecycle: record.lastStatus ?? "closed",
      requiresAttention: record.requiresAttention === true,
      attentionReason: record.attentionReason ?? null,
      pendingPermissionLabels: [],
      lastError: record.lastError ?? null,
      updatedAtIso: record.updatedAt,
      triage: deps.store.getTriage(record.id),
    };
  }

  function classifyFleetItem(
    item: FleetSessionSnapshotItem,
  ): keyof Omit<FleetSnapshotSummary, "totalActive"> {
    const phase = item.triage?.phase ?? null;
    if (
      item.pendingPermissionLabels.length > 0 ||
      phase === "blocked_user" ||
      item.attentionReason === "permission"
    ) {
      return "needsYou";
    }
    if (
      item.lifecycle === "error" ||
      Boolean(item.lastError) ||
      phase === "interrupted" ||
      phase === "stalled" ||
      phase === "no_progress"
    ) {
      return "problematic";
    }
    if (item.lifecycle === "running" || item.lifecycle === "initializing") {
      return "running";
    }
    if (item.requiresAttention || phase === "done" || phase === "blocked_external") {
      return "attentionDone";
    }
    return "idleOther";
  }

  async function scanFleetUncached(mainAgentId?: string | null): Promise<FleetSnapshotSummary> {
    if (deps.collectMultiHostFleet) {
      const multiHost = await deps.collectMultiHostFleet(mainAgentId);
      if (multiHost) {
        return multiHost;
      }
    }

    const byId = new Map<string, FleetSessionSnapshotItem>();

    for (const agent of deps.agentManager.listAgents()) {
      if (
        agent.internal ||
        agent.background ||
        isMainChatLabels(agent.labels) ||
        isMainChatConversationLabels(agent.labels)
      ) {
        continue;
      }
      byId.set(agent.id, toLiveItem(agent, mainAgentId));
    }

    const stored = await deps.agentStorage.listActive();
    for (const record of stored) {
      if (
        record.archivedAt ||
        record.internal ||
        record.background ||
        isMainChatLabels(record.labels) ||
        isMainChatConversationLabels(record.labels)
      ) {
        continue;
      }
      if (byId.has(record.id)) continue;
      byId.set(record.id, toStoredItem(record, mainAgentId));
    }

    const items = Array.from(byId.values()).sort((left, right) =>
      right.updatedAtIso.localeCompare(left.updatedAtIso),
    );

    const summary = emptyFleetSummary();
    summary.totalActive = items.length;
    for (const item of items) {
      summary[classifyFleetItem(item)].push(item);
    }
    return summary;
  }

  function computeLiveFingerprint(): string {
    const parts: string[] = [];
    for (const agent of deps.agentManager.listAgents()) {
      if (agent.internal || agent.background || isMainChatLabels(agent.labels)) continue;
      parts.push(
        `${agent.id}:${agent.lifecycle}:${agent.pendingPermissions.size}:${agent.attention.requiresAttention ? "1" : "0"}:${agent.lastError ? "1" : "0"}`,
      );
    }
    parts.sort();
    return parts.join("|");
  }

  function startRefresh(
    cacheKey: string,
    mainAgentId?: string | null,
  ): Promise<FleetSnapshotSummary> {
    const existing = inFlightRefreshByKey.get(cacheKey);
    if (existing) return existing;

    const capturedGeneration = cacheGeneration;
    const promise = scanFleetUncached(mainAgentId)
      .then((summary) => {
        const currentEntry = cacheByKey.get(cacheKey);
        if (capturedGeneration === cacheGeneration || !currentEntry) {
          cacheByKey.set(cacheKey, {
            summary,
            collectedAtMs: getNowMs(),
            liveFingerprint: computeLiveFingerprint(),
            invalidated: false,
          });
        }
        return summary;
      })
      .finally(() => {
        if (inFlightRefreshByKey.get(cacheKey) === promise) {
          inFlightRefreshByKey.delete(cacheKey);
        }
      });

    inFlightRefreshByKey.set(cacheKey, promise);
    return promise;
  }

  function isCacheFresh(entry: CachedFleetEntry | undefined): boolean {
    if (!entry || entry.invalidated) return false;
    if (getNowMs() - entry.collectedAtMs >= cacheTtlMs) return false;
    return entry.liveFingerprint === computeLiveFingerprint();
  }

  async function resolveFleetForTurn(
    mainAgentId: string,
    foreground: boolean,
  ): Promise<{ fleet: FleetSnapshotSummary; stale: boolean }> {
    const cacheKey = mainAgentId || GLOBAL_CACHE_KEY;
    const cached = cacheByKey.get(cacheKey);
    if (cached && isCacheFresh(cached)) {
      return { fleet: cached.summary, stale: false };
    }

    const refreshPromise = startRefresh(cacheKey, mainAgentId);
    if (!foreground) {
      const fleet = await refreshPromise;
      return { fleet, stale: false };
    }

    // Keep background refresh alive without leaking unhandled rejections if foreground times out.
    refreshPromise.catch(() => undefined);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const outcome = await Promise.race<
      { kind: "fresh"; fleet: FleetSnapshotSummary } | { kind: "timeout" }
    >([
      refreshPromise.then((fleet) => ({ kind: "fresh" as const, fleet })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), foregroundTimeoutMs);
        timer.unref?.();
      }),
    ]).finally(() => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    });

    if (outcome.kind === "fresh") {
      return { fleet: outcome.fleet, stale: false };
    }

    if (cached && getNowMs() - cached.collectedAtMs <= SNAPSHOT_STALE_FALLBACK_MAX_AGE_MS) {
      return { fleet: cached.summary, stale: true };
    }
    return { fleet: emptyFleetSummary(), stale: true };
  }

  function buildLogicalSections(input: {
    fleet: FleetSnapshotSummary;
    plans: MainChatPlanRecord[];
    openDecisions: MainChatDecisionRecord[];
  }): LogicalSection[] {
    const { fleet, plans, openDecisions } = input;
    // Strict priority order:
    // 1. needs_you & decisions  2. problematic  3. plans  4. running (compressed)  5. completed  6. other
    return [
      {
        key: "needs_you",
        title: "等你拍板 / 待审批",
        rows: fleet.needsYou.map(formatDetailedRow),
      },
      {
        key: "decisions",
        title: "待回答的决策卡",
        rows: buildDecisionRows(openDecisions),
      },
      {
        key: "problematic",
        title: "异常中断 / 停滞 / 空转",
        rows: fleet.problematic.map(formatDetailedRow),
      },
      {
        key: "plans",
        title: "活跃计划与受控任务",
        rows: buildPlanRows(plans),
      },
      {
        key: "running",
        title: "进行中工作态摘要",
        rows: buildWorkingRows(fleet.running),
      },
      {
        key: "completed",
        title: "刚完成 / 待查收 / 等外部条件",
        rows: fleet.attentionDone.map(formatDetailedRow),
      },
      {
        key: "other",
        title: "其他空闲会话",
        rows: buildOtherIdleRows(fleet.idleOther),
      },
    ];
  }

  function renderSectionDelta(input: {
    section: LogicalSection;
    prevRowMap: Map<string, SnapshotRow>;
    remainingChars: number;
  }): {
    block: string | null;
    nextBaseline: Map<string, SnapshotRow>;
  } {
    const { section, prevRowMap, remainingChars } = input;
    const currentRowMap = new Map<string, SnapshotRow>(section.rows.map((row) => [row.id, row]));
    const diffLines: Array<{ rendered: string; row?: SnapshotRow }> = [];

    for (const row of section.rows) {
      const prev = prevRowMap.get(row.id);
      if (!prev || prev.text !== row.text) {
        diffLines.push({ rendered: `+ ${row.text}`, row });
      }
    }
    for (const [prevId, prevRow] of prevRowMap.entries()) {
      if (!currentRowMap.has(prevId)) {
        diffLines.push({ rendered: `- 已移出：${prevRow.shortLabel}` });
      }
    }

    if (diffLines.length === 0) {
      return { block: null, nextBaseline: prevRowMap };
    }

    const packed = packSectionBlock({
      heading: `### ${section.title}（增量变更）`,
      lines: diffLines,
      remainingChars,
    });

    const nextBaseline = new Map<string, SnapshotRow>();
    for (const [prevId, prevRow] of prevRowMap.entries()) {
      const latest = currentRowMap.get(prevId);
      if (latest) {
        nextBaseline.set(prevId, latest.text === prevRow.text ? latest : prevRow);
      }
    }
    for (const included of packed.includedRows) {
      nextBaseline.set(included.id, included);
    }
    return { block: packed.block, nextBaseline };
  }

  function renderSectionForTurn(input: {
    section: LogicalSection;
    isFull: boolean;
    previousSections: Map<string, Map<string, SnapshotRow>> | undefined;
    remainingChars: number;
  }): {
    block: string | null;
    nextBaseline: Map<string, SnapshotRow>;
  } {
    const { section, isFull, previousSections, remainingChars } = input;
    if (!isFull) {
      return renderSectionDelta({
        section,
        prevRowMap: previousSections?.get(section.key) ?? new Map<string, SnapshotRow>(),
        remainingChars,
      });
    }
    if (section.rows.length === 0) {
      return { block: null, nextBaseline: new Map() };
    }
    const packed = packSectionBlock({
      heading: `### ${section.title}`,
      lines: section.rows.map((row) => ({ rendered: `- ${row.text}`, row })),
      remainingChars,
    });
    return {
      block: packed.block,
      nextBaseline: new Map(packed.includedRows.map((row) => [row.id, row])),
    };
  }

  return {
    async collectFleet(mainAgentId, options) {
      const cacheKey = mainAgentId ?? GLOBAL_CACHE_KEY;
      const cached = cacheByKey.get(cacheKey);
      if (!options?.bypassCache && cached && isCacheFresh(cached)) {
        return cached.summary;
      }
      return startRefresh(cacheKey, mainAgentId);
    },

    async buildTurnContext(mainAgentId, options) {
      const settings = deps.store.getSettings();
      const { fleet, stale } = await resolveFleetForTurn(mainAgentId, options?.foreground === true);
      const plans = deps.store.listPlans(mainAgentId);
      const openDecisions = deps.store
        .listDecisions(mainAgentId)
        .filter((decision) => !decision.answeredAt);

      const previousSections = options?.forceFull
        ? undefined
        : lastRowsByMainAgent.get(mainAgentId);
      const isFull = !previousSections;

      const header = isFull
        ? "以下是 Paseo 自动注入的全机实时快照（不是用户输入的文本；如需更多细节请用 get_agent_activity / task_list 查询）："
        : "以下是相对上一轮快照有变化的实时状态（未列出的段落与行均与上一轮一致）：";

      const metaLines = [
        `- 时间：${formatNowLocal(new Date(getNowMs()))}`,
        `- 管家名称：${settings.title}`,
        `- 风格策略：${formatStyleSummary(settings)}`,
        `- 活跃会话总览：共 ${fleet.totalActive} 个（等你拍板 ${fleet.needsYou.length}，异常/卡住 ${fleet.problematic.length}，运行中 ${fleet.running.length}，刚完成/待查收 ${fleet.attentionDone.length}）`,
      ];
      if (stale) {
        metaLines.push(
          "- ⚠️ 缓存略旧，后台刷新中（为保证前台响应已先返回最近快照，下轮自动同步最新状态）",
        );
      }

      const blocks: string[] = [header, `### 当前时间与管家配置\n${metaLines.join("\n")}`];
      let usedChars = blocks.join("\n\n").length;

      const handoff = options?.handoffSummary?.trim();
      if (handoff) {
        const handoffReserve = Math.min(1_800, Math.max(200, Math.floor(maxSnapshotChars * 0.3)));
        const handoffBlock = `### 上一任主对话交接摘要\n${truncateMultiline(handoff, handoffReserve - 30)}`;
        if (usedChars + 2 + handoffBlock.length <= maxSnapshotChars) {
          blocks.push(handoffBlock);
          usedChars += 2 + handoffBlock.length;
        }
      }

      const sections = buildLogicalSections({ fleet, plans, openDecisions });
      const nextSections = new Map<string, Map<string, SnapshotRow>>();

      for (const section of sections) {
        const rendered = renderSectionForTurn({
          section,
          isFull,
          previousSections,
          remainingChars: maxSnapshotChars - usedChars,
        });
        if (rendered.block) {
          blocks.push(rendered.block);
          usedChars += 2 + rendered.block.length;
        }
        nextSections.set(section.key, rendered.nextBaseline);
      }

      if (!stale || isFull) {
        lastRowsByMainAgent.set(mainAgentId, nextSections);
      }

      const output = blocks.join("\n\n");
      if (output.length <= maxSnapshotChars) {
        return output;
      }
      const suffix = "\n...（超出快照预算已截断）";
      return `${output.slice(0, Math.max(0, maxSnapshotChars - suffix.length))}${suffix}`;
    },

    resetDelta(mainAgentId) {
      lastRowsByMainAgent.delete(mainAgentId);
    },

    invalidateCache(mainAgentId) {
      cacheGeneration += 1;
      if (mainAgentId) {
        const entry = cacheByKey.get(mainAgentId);
        if (entry) entry.invalidated = true;
        inFlightRefreshByKey.delete(mainAgentId);
        return;
      }
      for (const entry of cacheByKey.values()) {
        entry.invalidated = true;
      }
      inFlightRefreshByKey.clear();
    },
  };
}
