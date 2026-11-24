import type {
  MainChatProjectLesson,
  MainChatTaskDeliveryGate,
  MainChatTaskDependencyState,
  MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import type { StatusBadgeVariant } from "@/components/ui/status-badge";

export interface DeliveryGateBadgeDescriptor {
  prRef: string;
  prNumber: number | null;
  statusKey:
    | "mainChat.deliveryGate.statusDraft"
    | "mainChat.deliveryGate.statusConflict"
    | "mainChat.deliveryGate.statusCiFailing"
    | "mainChat.deliveryGate.statusCiPending"
    | "mainChat.deliveryGate.statusOpen"
    | "mainChat.deliveryGate.statusReady"
    | "mainChat.deliveryGate.statusMerged"
    | "mainChat.deliveryGate.statusClosed";
  variant: StatusBadgeVariant;
  isBlocked: boolean;
  isMerged: boolean;
  followUpActive: boolean;
  blockers: readonly string[];
  prUrl: string | null;
}

export interface TaskDagSummary {
  partOf: string | null;
  parentTitle: string | null;
  parentTask: MainChatTaskRecord | null;
  children: MainChatTaskRecord[];
  childrenTotal: number;
  childrenCompleted: number;
  allChildrenDone: boolean;
  dependencyState: MainChatTaskDependencyState;
  afterIds: string[];
  blockedByIds: string[];
  blockedByTitles: string[];
  canStartReady: boolean;
}

function isTaskDependencySatisfied(task: MainChatTaskRecord | undefined): boolean {
  if (!task) return true;
  return task.status === "completed" || task.deliveryGate?.prState === "merged";
}

function hasDeliveryGateSignal(gate: MainChatTaskDeliveryGate): boolean {
  return Boolean(
    gate.prUrl ||
    gate.prNumber ||
    gate.prState !== null ||
    gate.gateStatus !== "clear" ||
    gate.blockingReasons.length > 0,
  );
}

function resolveDeliveryGateClassification(gate: MainChatTaskDeliveryGate): {
  statusKey: DeliveryGateBadgeDescriptor["statusKey"];
  variant: StatusBadgeVariant;
  isBlocked: boolean;
  isMerged: boolean;
} {
  const hasBlockers = gate.blockingReasons.length > 0;
  if (gate.prState === "merged" || gate.gateStatus === "merged") {
    return {
      statusKey: "mainChat.deliveryGate.statusMerged",
      variant: "success",
      isBlocked: false,
      isMerged: true,
    };
  }
  if (gate.hasConflict || gate.gateStatus === "conflict") {
    return {
      statusKey: "mainChat.deliveryGate.statusConflict",
      variant: "error",
      isBlocked: true,
      isMerged: false,
    };
  }
  if (gate.ciStatus === "failing" || gate.gateStatus === "ci_failed") {
    return {
      statusKey: "mainChat.deliveryGate.statusCiFailing",
      variant: "error",
      isBlocked: true,
      isMerged: false,
    };
  }
  if (gate.isDraft || gate.gateStatus === "draft") {
    return {
      statusKey: "mainChat.deliveryGate.statusDraft",
      variant: "warning",
      isBlocked: true,
      isMerged: false,
    };
  }
  if (gate.prState === "closed" || gate.gateStatus === "closed") {
    return {
      statusKey: "mainChat.deliveryGate.statusClosed",
      variant: "error",
      isBlocked: hasBlockers,
      isMerged: false,
    };
  }
  if (gate.ciStatus === "pending") {
    return {
      statusKey: "mainChat.deliveryGate.statusCiPending",
      variant: "warning",
      isBlocked: hasBlockers,
      isMerged: false,
    };
  }
  if (gate.gateStatus === "clear" && !hasBlockers) {
    return {
      statusKey: "mainChat.deliveryGate.statusReady",
      variant: "success",
      isBlocked: false,
      isMerged: false,
    };
  }
  return {
    statusKey: "mainChat.deliveryGate.statusOpen",
    variant: hasBlockers ? "error" : "warning",
    isBlocked: hasBlockers,
    isMerged: false,
  };
}

export function deriveDeliveryGateBadge(
  gate: MainChatTaskDeliveryGate | null | undefined,
): DeliveryGateBadgeDescriptor | null {
  if (!gate || !hasDeliveryGateSignal(gate)) return null;
  const classification = resolveDeliveryGateClassification(gate);
  return {
    prRef: gate.prNumber ? `PR #${gate.prNumber}` : "PR",
    prNumber: gate.prNumber ?? null,
    followUpActive: Boolean(gate.followUpActive),
    blockers: gate.blockingReasons,
    prUrl: gate.prUrl ?? null,
    ...classification,
  };
}

function resolveDependencyState(
  task: MainChatTaskRecord,
  afterIds: readonly string[],
  blockedByIds: readonly string[],
): MainChatTaskDependencyState {
  if (afterIds.length === 0) {
    return task.dependencyState ?? "none";
  }
  if (task.activeAgentId || task.status === "completed") {
    return "none";
  }
  if (task.status === "open") {
    return blockedByIds.length > 0 ? "blocked" : "ready";
  }
  return task.dependencyState ?? "none";
}

function isActiveChildSlice(candidate: MainChatTaskRecord, parentId: string): boolean {
  return (
    candidate.id !== parentId &&
    candidate.partOf === parentId &&
    !candidate.supersededByTaskId &&
    candidate.status !== "cancelled"
  );
}

export function deriveTaskDagSummary(
  task: MainChatTaskRecord | null | undefined,
  allTasks: readonly MainChatTaskRecord[] | undefined,
): TaskDagSummary {
  if (!task) {
    return {
      partOf: null,
      parentTitle: null,
      parentTask: null,
      children: [],
      childrenTotal: 0,
      childrenCompleted: 0,
      allChildrenDone: false,
      dependencyState: "none",
      afterIds: [],
      blockedByIds: [],
      blockedByTitles: [],
      canStartReady: false,
    };
  }

  const list = allTasks ?? [];
  const taskById = new Map<string, MainChatTaskRecord>(list.map((item) => [item.id, item]));
  taskById.set(task.id, task);

  const partOf = task.partOf?.trim() || null;
  const parentTask = partOf ? (taskById.get(partOf) ?? null) : null;
  const children = list.filter((candidate) => isActiveChildSlice(candidate, task.id));
  const childrenCompleted = children.filter((child) => isTaskDependencySatisfied(child)).length;
  const isTerminal = task.status === "completed" || task.status === "cancelled";
  const allChildrenDone =
    children.length > 0 && childrenCompleted === children.length && !isTerminal;

  const afterIds = (task.after ?? []).filter((depId) => Boolean(depId) && depId !== task.id);
  const blockedByIds = afterIds.filter((depId) => {
    const depTask = taskById.get(depId);
    return depTask ? !isTaskDependencySatisfied(depTask) : true;
  });
  const blockedByTitles = blockedByIds.map((depId) => taskById.get(depId)?.title ?? depId);
  const dependencyState = resolveDependencyState(task, afterIds, blockedByIds);

  return {
    partOf,
    parentTitle: parentTask?.title ?? partOf,
    parentTask,
    children,
    childrenTotal: children.length,
    childrenCompleted,
    allChildrenDone,
    dependencyState,
    afterIds,
    blockedByIds,
    blockedByTitles,
    canStartReady: dependencyState === "ready" && !task.activeAgentId && !isTerminal,
  };
}

function appendUniqueItems<T>(
  target: T[],
  emitted: Set<T>,
  source: readonly T[] | undefined,
): void {
  if (!source) return;
  for (const item of source) {
    if (emitted.has(item)) continue;
    emitted.add(item);
    target.push(item);
  }
}

/**
 * Reorders a bucket's task items so that child slices (`partOf`) sit immediately under their
 * parent task when both appear in the same bucket, while preserving recency ordering among
 * top-level items and among siblings.
 */
export function orderBucketItemsWithHierarchy<
  T extends { taskId: string | null; partOf: string | null },
>(items: readonly T[]): T[] {
  if (items.length <= 1) return [...items];
  const presentTaskIds = new Set<string>();
  for (const item of items) {
    if (item.taskId) presentTaskIds.add(item.taskId);
  }

  const childrenByParent = new Map<string, T[]>();
  const roots: T[] = [];
  for (const item of items) {
    if (item.partOf && presentTaskIds.has(item.partOf) && item.partOf !== item.taskId) {
      const list = childrenByParent.get(item.partOf) ?? [];
      list.push(item);
      childrenByParent.set(item.partOf, list);
    } else {
      roots.push(item);
    }
  }

  const ordered: T[] = [];
  const emitted = new Set<T>();
  for (const root of roots) {
    appendUniqueItems(ordered, emitted, [root]);
    if (root.taskId) {
      appendUniqueItems(ordered, emitted, childrenByParent.get(root.taskId));
    }
  }
  appendUniqueItems(ordered, emitted, items);
  return ordered;
}

export function countProjectLessonsForTask(
  lessons: readonly MainChatProjectLesson[] | undefined,
  task: MainChatTaskRecord | null | undefined,
): number {
  if (!lessons || lessons.length === 0) return 0;
  if (!task) return lessons.length;
  const cwd = task.cwd?.trim().toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
  if (!cwd) return lessons.length;
  const matched = lessons.filter((lesson) => {
    const key = lesson.projectKey.trim().toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
    if (!key) return false;
    return (
      cwd === key ||
      cwd.startsWith(`${key}/`) ||
      key.endsWith(`/${cwd.split("/").pop() ?? ""}`) ||
      (lesson.projectLabel &&
        task.workspaceLabel &&
        lesson.projectLabel.toLowerCase() === task.workspaceLabel.toLowerCase())
    );
  });
  return matched.length > 0 ? matched.length : lessons.length;
}
