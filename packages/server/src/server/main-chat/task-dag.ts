import type { MainChatTaskDependencyState, MainChatTaskRecord } from "@getpaseo/protocol/main-chat";

export type TaskDagErrorCode =
  | "self_dependency"
  | "self_parent"
  | "missing_target"
  | "invalid_parent_nesting"
  | "cross_parent_dependency"
  | "parent_child_deadlock"
  | "parent_change_has_dependents"
  | "cycle_detected";

export class TaskDagValidationError extends Error {
  constructor(
    public readonly code: TaskDagErrorCode,
    message: string,
    public readonly details?: {
      taskId?: string;
      targetId?: string;
      cyclePath?: string[];
    },
  ) {
    super(message);
    this.name = "TaskDagValidationError";
  }
}

export interface TaskDagNodeInput {
  id: string;
  partOf?: string | null;
  after?: readonly string[];
}

export interface NormalizedTaskDagLinks {
  partOf: string | null;
  after: string[];
}

export interface ReadyDownstreamTaskCandidate {
  task: MainChatTaskRecord;
  wakeKey: string;
  satisfiedPrerequisites: Array<{
    id: string;
    title: string;
    reason: "completed" | "pr_merged";
    prUrl: string | null;
  }>;
}

export interface ParentCloseoutCandidate {
  parent: MainChatTaskRecord;
  wakeKey: string;
  children: Array<{
    id: string;
    title: string;
    prUrl: string | null;
  }>;
}

export function cleanTaskIdList(ids: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids ?? []) {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeOptionalTaskId(id: string | null | undefined): string | null {
  const trimmed = id?.trim();
  return trimmed ? trimmed : null;
}

interface TaskDagNode {
  id: string;
  partOf: string | null;
  after: string[];
}

function buildGraphMap(
  existingTasks: readonly MainChatTaskRecord[],
  updates: readonly TaskDagNodeInput[],
): Map<string, TaskDagNode> {
  const graph = new Map<string, TaskDagNode>();
  for (const task of existingTasks) {
    graph.set(task.id, {
      id: task.id,
      partOf: normalizeOptionalTaskId(task.partOf),
      after: cleanTaskIdList(task.after),
    });
  }
  for (const update of updates) {
    const existing = graph.get(update.id);
    const nextPartOf =
      update.partOf !== undefined
        ? normalizeOptionalTaskId(update.partOf)
        : (existing?.partOf ?? null);
    const nextAfter =
      update.after !== undefined ? cleanTaskIdList(update.after) : (existing?.after ?? []);
    graph.set(update.id, {
      id: update.id,
      partOf: nextPartOf,
      after: nextAfter,
    });
  }
  return graph;
}

/**
 * Finds a directed cycle starting from `startId` through `after` edges in `graph`.
 * Returns the cycle node IDs in traversal order (e.g. `["a", "b", "a"]`), or `null` if acyclic.
 */
export function findDependencyCyclePath(
  graph: ReadonlyMap<string, { after: readonly string[] }>,
  startId: string,
): string[] | null {
  const visiting = new Set<string>([startId]);
  const visited = new Set<string>();

  function dfs(currentId: string, path: string[]): string[] | null {
    const node = graph.get(currentId);
    if (!node) return null;
    for (const depId of node.after) {
      if (depId === startId) {
        return [...path, depId];
      }
      if (visiting.has(depId)) {
        const cycleStart = path.indexOf(depId);
        return cycleStart >= 0 ? [...path.slice(cycleStart), depId] : [...path, depId];
      }
      if (visited.has(depId)) continue;
      visiting.add(depId);
      const found = dfs(depId, [...path, depId]);
      visiting.delete(depId);
      visited.add(depId);
      if (found) return found;
    }
    return null;
  }

  return dfs(startId, [startId]);
}

/**
 * Strictly validates a batch of proposed task DAG links (`partOf` + `after`) against existing
 * tasks atomically so simultaneous cyclic writes (`A after B` and `B after A`), self-dependencies,
 * multi-level parent nesting, cross-parent dependencies, and parent/child deadlocks are all
 * rejected with actionable error messages before anything is written.
 */
function validateNodeParentRule(
  graph: Map<string, TaskDagNode>,
  node: TaskDagNode,
  prev: MainChatTaskRecord | undefined,
): void {
  if (node.partOf !== null) {
    if (node.partOf === node.id) {
      throw new TaskDagValidationError("self_parent", `任务 ${node.id} 的 partOf 不能指向自己`, {
        taskId: node.id,
        targetId: node.partOf,
      });
    }
    const parentNode = graph.get(node.partOf);
    if (!parentNode) {
      throw new TaskDagValidationError(
        "missing_target",
        `partOf 指向的父任务不存在：${node.partOf}`,
        { taskId: node.id, targetId: node.partOf },
      );
    }
    if (parentNode.partOf !== null) {
      throw new TaskDagValidationError(
        "invalid_parent_nesting",
        `父任务 ${node.partOf} 本身已是 ${parentNode.partOf} 的子片（仅支持一层父子拆片），请直接指向根任务 ${parentNode.partOf}`,
        { taskId: node.id, targetId: node.partOf },
      );
    }
    for (const other of graph.values()) {
      if (other.id !== node.id && other.partOf === node.id) {
        throw new TaskDagValidationError(
          "invalid_parent_nesting",
          `任务 ${node.id} 下已有子片（如 ${other.id}），不能再作为其他任务的 partOf 子片`,
          { taskId: node.id, targetId: other.id },
        );
      }
    }
  }

  if (!prev || (prev.partOf ?? null) === node.partOf) {
    return;
  }

  const waitingSiblings: string[] = [];
  for (const other of graph.values()) {
    if (
      other.id !== node.id &&
      other.after.includes(node.id) &&
      other.partOf !== null &&
      other.partOf !== node.partOf
    ) {
      waitingSiblings.push(other.id);
    }
  }
  if (waitingSiblings.length > 0) {
    throw new TaskDagValidationError(
      "parent_change_has_dependents",
      `任务 ${waitingSiblings.join("、")} 仍在 after 中依赖 ${node.id}，无法变更其归属父任务；请先解除对应依赖`,
      { taskId: node.id },
    );
  }
}

function validateNodeAfterRules(graph: Map<string, TaskDagNode>, node: TaskDagNode): void {
  for (const depId of node.after) {
    if (depId === node.id) {
      throw new TaskDagValidationError(
        "self_dependency",
        `任务 ${node.id} 的 after 不能依赖自己（自依赖被拒绝）`,
        { taskId: node.id, targetId: depId },
      );
    }
    const depNode = graph.get(depId);
    if (!depNode) {
      throw new TaskDagValidationError(
        "missing_target",
        `after 指向的前置依赖任务不存在：${depId}`,
        { taskId: node.id, targetId: depId },
      );
    }
    if (node.partOf !== null && depId === node.partOf) {
      throw new TaskDagValidationError(
        "parent_child_deadlock",
        `子任务 ${node.id} 不能在 after 中依赖其父任务 ${node.partOf}（会形成死锁）`,
        { taskId: node.id, targetId: depId },
      );
    }
    if (depNode.partOf === node.id) {
      throw new TaskDagValidationError(
        "parent_child_deadlock",
        `父任务 ${node.id} 无需在 after 中依赖其子片 ${depId}（全部子片完成后会自动触发 parent_closeout）`,
        { taskId: node.id, targetId: depId },
      );
    }
    if (node.partOf !== null && depNode.partOf !== null && depNode.partOf !== node.partOf) {
      throw new TaskDagValidationError(
        "cross_parent_dependency",
        `子任务 ${node.id}（父任务 ${node.partOf}）不能依赖其他父任务 ${depNode.partOf} 的子片 ${depId}`,
        { taskId: node.id, targetId: depId },
      );
    }
  }
}

export function validateTaskDagBatch(
  existingTasks: readonly MainChatTaskRecord[],
  updates: readonly TaskDagNodeInput[],
): Map<string, NormalizedTaskDagLinks> {
  const existingById = new Map(existingTasks.map((task) => [task.id, task]));
  const graph = buildGraphMap(existingTasks, updates);

  for (const update of updates) {
    const node = graph.get(update.id)!;
    validateNodeParentRule(graph, node, existingById.get(update.id));
    validateNodeAfterRules(graph, node);
  }

  for (const update of updates) {
    const cyclePath = findDependencyCyclePath(graph, update.id);
    if (cyclePath) {
      throw new TaskDagValidationError(
        "cycle_detected",
        `检测到循环依赖：${cyclePath.join(" -> ")}，已拒绝写入`,
        { taskId: update.id, cyclePath },
      );
    }
  }

  const normalized = new Map<string, NormalizedTaskDagLinks>();
  for (const update of updates) {
    const node = graph.get(update.id)!;
    normalized.set(update.id, {
      partOf: node.partOf,
      after: node.after,
    });
  }
  return normalized;
}

/**
 * Checks whether a prerequisite task counts as satisfied:
 * - Cancelled or failed tasks NEVER satisfy a dependency.
 * - Completed tasks (accepted via `task_review` / `task_complete`) satisfy the dependency.
 * - Open tasks whose tracked delivery PR is observed as `merged` satisfy the dependency.
 */
export function evaluatePrerequisiteSatisfaction(dep: MainChatTaskRecord | null | undefined): {
  satisfied: boolean;
  reason: "completed" | "pr_merged" | null;
  prUrl: string | null;
} {
  if (!dep) {
    return { satisfied: false, reason: null, prUrl: null };
  }
  if (dep.status === "cancelled" || dep.status === "failed") {
    return { satisfied: false, reason: null, prUrl: dep.deliveryGate?.prUrl ?? null };
  }
  if (dep.status === "completed") {
    return {
      satisfied: true,
      reason: "completed",
      prUrl: dep.deliveryGate?.prUrl ?? null,
    };
  }
  if (dep.deliveryGate?.prState === "merged") {
    return {
      satisfied: true,
      reason: "pr_merged",
      prUrl: dep.deliveryGate.prUrl ?? null,
    };
  }
  return { satisfied: false, reason: null, prUrl: dep.deliveryGate?.prUrl ?? null };
}

export function computeTaskDependencyState(
  task: Pick<MainChatTaskRecord, "after">,
  tasksById: ReadonlyMap<string, MainChatTaskRecord>,
): MainChatTaskDependencyState {
  const after = cleanTaskIdList(task.after);
  if (after.length === 0) return "none";
  for (const depId of after) {
    const verdict = evaluatePrerequisiteSatisfaction(tasksById.get(depId));
    if (!verdict.satisfied) {
      return "blocked";
    }
  }
  return "ready";
}

export function buildTodoReadyWakeKey(taskId: string, afterIds: readonly string[]): string {
  const sorted = [...cleanTaskIdList(afterIds)].sort();
  return `todo_ready:${taskId}:after:${sorted.join(",")}`;
}

export function buildParentCloseoutWakeKey(parentId: string, childIds: readonly string[]): string {
  const sorted = [...cleanTaskIdList(childIds)].sort();
  return `parent_closeout:${parentId}:children:${sorted.join(",")}`;
}

/**
 * Finds all open, unstarted dependent tasks whose `after` prerequisites include `completedTaskId`
 * (or any newly satisfied dependency) and now have EVERY prerequisite satisfied.
 */
export function findNewlyReadyDownstreamTasks(input: {
  allTasks: readonly MainChatTaskRecord[];
  changedTaskId: string;
}): ReadyDownstreamTaskCandidate[] {
  const byId = new Map(input.allTasks.map((task) => [task.id, task]));
  const results: ReadyDownstreamTaskCandidate[] = [];

  for (const candidate of input.allTasks) {
    if (candidate.id === input.changedTaskId) continue;
    if (candidate.status !== "open") continue;
    if (candidate.activeAgentId || candidate.agentIds.length > 0) continue;

    const after = cleanTaskIdList(candidate.after);
    if (after.length === 0 || !after.includes(input.changedTaskId)) continue;

    const satisfiedPrerequisites: ReadyDownstreamTaskCandidate["satisfiedPrerequisites"] = [];
    let allSatisfied = true;
    for (const depId of after) {
      const dep = byId.get(depId);
      const verdict = evaluatePrerequisiteSatisfaction(dep);
      if (!verdict.satisfied || !dep || !verdict.reason) {
        allSatisfied = false;
        break;
      }
      satisfiedPrerequisites.push({
        id: dep.id,
        title: dep.title,
        reason: verdict.reason,
        prUrl: verdict.prUrl,
      });
    }

    if (allSatisfied) {
      results.push({
        task: candidate,
        wakeKey: buildTodoReadyWakeKey(candidate.id, after),
        satisfiedPrerequisites,
      });
    }
  }

  return results;
}

/**
 * Checks whether completing `completedChild` makes its `partOf` parent ready for closeout:
 * - Parent exists, is open (not completed / cancelled), and has no currently running agent.
 * - Parent has >= 1 real `partOf` children, and EVERY child has `status === "completed"`.
 */
export function checkParentCloseoutCandidate(input: {
  allTasks: readonly MainChatTaskRecord[];
  completedChild: MainChatTaskRecord;
  isAgentLiveRunning?: (agentId: string) => boolean;
}): ParentCloseoutCandidate | null {
  const parentId = normalizeOptionalTaskId(input.completedChild.partOf);
  if (!parentId) return null;

  const parent = input.allTasks.find((task) => task.id === parentId);
  if (!parent) return null;
  if (parent.status === "completed" || parent.status === "cancelled") {
    return null;
  }
  if (parent.activeAgentId && input.isAgentLiveRunning?.(parent.activeAgentId)) {
    return null;
  }

  const children = input.allTasks
    .filter((task) => normalizeOptionalTaskId(task.partOf) === parent.id && task.id !== parent.id)
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  if (children.length === 0) return null;

  for (const child of children) {
    if (child.status !== "completed") {
      return null;
    }
  }

  return {
    parent,
    wakeKey: buildParentCloseoutWakeKey(
      parent.id,
      children.map((child) => child.id),
    ),
    children: children.map((child) => ({
      id: child.id,
      title: child.title,
      prUrl: child.deliveryGate?.prUrl ?? null,
    })),
  };
}
