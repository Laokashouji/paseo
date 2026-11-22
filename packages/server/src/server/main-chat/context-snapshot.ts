import path from "node:path";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import {
  getMainChatTaskMetaFromLabels,
  isMainChatLabels,
  type MainChatDecisionRecord,
  type MainChatPlanRecord,
  type MainChatSessionTriage,
  type MainChatSettings,
} from "@getpaseo/protocol/main-chat";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { MainChatStore } from "./store.js";

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

export interface MainChatContextSnapshotBuilder {
  collectFleet(mainAgentId?: string | null): Promise<FleetSnapshotSummary>;
  buildTurnContext(mainAgentId: string, options?: { forceFull?: boolean }): Promise<string>;
  resetDelta(mainAgentId: string): void;
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
    return `${label}（${desc.slice(0, 60)}）`;
  }
  return label;
}

function formatItemLine(item: FleetSessionSnapshotItem): string {
  const tag = item.managedByMainChat ? "管家派发" : "手动会话";
  const base = `「${item.title}」[${tag} · ${item.projectName} · id=${item.agentId}]`;
  const parts: string[] = [];
  if (item.pendingPermissionLabels.length > 0) {
    parts.push(`待审批：${item.pendingPermissionLabels.slice(0, 2).join("；")}`);
  }
  if (item.triage) {
    const wait = item.triage.waitReason ? `（卡点：${item.triage.waitReason}）` : "";
    const next = item.triage.suggestedAction ? `；建议：${item.triage.suggestedAction}` : "";
    parts.push(`${item.triage.summary}${wait}${next}`);
  } else if (item.lastError) {
    parts.push(`报错：${item.lastError.slice(0, 120)}`);
  } else if (item.attentionReason) {
    parts.push(`状态：${item.attentionReason}`);
  }
  return parts.length > 0 ? `- ${base}：${parts.join(" | ")}` : `- ${base}`;
}

function formatStyleSummary(settings: MainChatSettings): string {
  const styleLabel =
    settings.style === "proactive"
      ? "激进模式（B · 主动代答与催促）"
      : "保守模式（A · 仅汇报建议）";
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

export function createMainChatContextSnapshotBuilder(deps: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  store: MainChatStore;
}): MainChatContextSnapshotBuilder {
  const lastSectionsByMainAgent = new Map<string, Map<string, string>>();

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

  async function collectFleet(mainAgentId?: string | null): Promise<FleetSnapshotSummary> {
    const byId = new Map<string, FleetSessionSnapshotItem>();

    for (const agent of deps.agentManager.listAgents()) {
      if (agent.background || isMainChatLabels(agent.labels)) continue;
      byId.set(agent.id, toLiveItem(agent, mainAgentId));
    }

    const stored = await deps.agentStorage.listActive();
    for (const record of stored) {
      if (record.archivedAt || record.background || isMainChatLabels(record.labels)) continue;
      if (byId.has(record.id)) continue;
      byId.set(record.id, toStoredItem(record, mainAgentId));
    }

    const items = Array.from(byId.values()).sort((left, right) =>
      right.updatedAtIso.localeCompare(left.updatedAtIso),
    );

    const summary: FleetSnapshotSummary = {
      totalActive: items.length,
      needsYou: [],
      problematic: [],
      running: [],
      attentionDone: [],
      idleOther: [],
    };

    for (const item of items) {
      summary[classifyFleetItem(item)].push(item);
    }

    return summary;
  }

  function renderSections(input: {
    now: Date;
    settings: MainChatSettings;
    fleet: FleetSnapshotSummary;
    openPlans: MainChatPlanRecord[];
    openDecisions: MainChatDecisionRecord[];
  }): Array<{ key: string; title: string; body: string; alwaysInclude?: boolean }> {
    const { now, settings, fleet, openPlans, openDecisions } = input;
    const sections: Array<{ key: string; title: string; body: string; alwaysInclude?: boolean }> =
      [];

    sections.push({
      key: "meta",
      title: "当前时间与管家配置",
      body: [
        `- 时间：${formatNowLocal(now)}`,
        `- 管家名称：${settings.title}`,
        `- 风格策略：${formatStyleSummary(settings)}`,
        `- 活跃会话总览：共 ${fleet.totalActive} 个（等你拍板 ${fleet.needsYou.length}，异常/卡住 ${fleet.problematic.length}，运行中 ${fleet.running.length}，刚完成/待查收 ${fleet.attentionDone.length}）`,
      ].join("\n"),
      alwaysInclude: true,
    });

    sections.push({
      key: "needs_you",
      title: "等你拍板 / 待审批",
      body:
        fleet.needsYou.length > 0
          ? fleet.needsYou.slice(0, 8).map(formatItemLine).join("\n")
          : "- 无",
    });

    sections.push({
      key: "problematic",
      title: "异常中断 / 停滞 / 空转",
      body:
        fleet.problematic.length > 0
          ? fleet.problematic.slice(0, 8).map(formatItemLine).join("\n")
          : "- 无",
    });

    sections.push({
      key: "running",
      title: "运行中",
      body:
        fleet.running.length > 0
          ? fleet.running.slice(0, 8).map(formatItemLine).join("\n")
          : "- 无",
    });

    sections.push({
      key: "attention_done",
      title: "刚完成 / 待查收 / 等外部条件",
      body:
        fleet.attentionDone.length > 0
          ? fleet.attentionDone.slice(0, 8).map(formatItemLine).join("\n")
          : "- 无",
    });

    if (openPlans.length > 0 || openDecisions.length > 0) {
      const lines: string[] = [];
      for (const plan of openPlans.slice(0, 5)) {
        const titles = plan.tasks.map((task) => task.title).join("、");
        lines.push(`- 待点击开始的计划（${plan.id}）：${titles}`);
      }
      for (const decision of openDecisions.slice(0, 5)) {
        lines.push(`- 待回答的决策卡（${decision.id}）：${decision.title} — ${decision.question}`);
      }
      sections.push({
        key: "pending_cards",
        title: "待处理的计划卡与决策卡",
        body: lines.join("\n"),
      });
    } else {
      sections.push({
        key: "pending_cards",
        title: "待处理的计划卡与决策卡",
        body: "- 无",
      });
    }

    return sections;
  }

  return {
    collectFleet,

    async buildTurnContext(mainAgentId, options) {
      const settings = deps.store.getSettings();
      const fleet = await collectFleet(mainAgentId);
      const openPlans = deps.store.listPlans(mainAgentId).filter((plan) => plan.status === "open");
      const openDecisions = deps.store
        .listDecisions(mainAgentId)
        .filter((decision) => !decision.answeredAt);

      const sections = renderSections({
        now: new Date(),
        settings,
        fleet,
        openPlans,
        openDecisions,
      });

      const previous = options?.forceFull ? undefined : lastSectionsByMainAgent.get(mainAgentId);
      const isFull = !previous;
      const nextMap = new Map<string, string>();
      const renderedBlocks: string[] = [];

      for (const section of sections) {
        nextMap.set(section.key, section.body);
        if (isFull || section.alwaysInclude || previous.get(section.key) !== section.body) {
          renderedBlocks.push(`### ${section.title}\n${section.body}`);
        }
      }

      lastSectionsByMainAgent.set(mainAgentId, nextMap);

      const header = isFull
        ? "以下是 Paseo 自动注入的全机实时快照（不是用户输入的文本；如需更多细节请用 get_agent_activity / task_list 查询）："
        : "以下是相对上一轮快照有变化的实时状态（未列出的段落与上一轮一致）：";
      return `${header}\n\n${renderedBlocks.join("\n\n")}`;
    },

    resetDelta(mainAgentId) {
      lastSectionsByMainAgent.delete(mainAgentId);
    },
  };
}
