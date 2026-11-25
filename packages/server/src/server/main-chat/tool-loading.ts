import { z } from "zod";
import { MainChatToolGroupIdSchema, type MainChatToolGroupId } from "@getpaseo/protocol/main-chat";
import { ensureValidJson } from "../json-utils.js";
import { addModelVisibleStructuredContent } from "../agent/tools/paseo-tool-serialization.js";
import type { PaseoToolDefinition } from "../agent/tools/types.js";

export interface MainChatToolGroupMetadata {
  id: MainChatToolGroupId;
  title: string;
  description: string;
  toolNames: readonly string[];
}

export const MAIN_CHAT_CORE_TOOL_NAMES: readonly string[] = [
  "task_list",
  "task_plan",
  "task_start",
  "task_review",
  "task_ask_user",
  "tool_catalog",
  "tool_load",
];

export const MAIN_CHAT_LEADER_CORE_TOOL_NAMES: readonly string[] = [
  "leader_progress",
  "ask_escalate",
];

export const MAIN_CHAT_DEFERRED_TOOL_GROUPS: readonly MainChatToolGroupMetadata[] = [
  {
    id: "memory",
    title: "常驻记忆目录 (Memory)",
    description: "读写与管理 ~/.paseo/main-chat/memory/ 下的长期偏好与项目笔记文件",
    toolNames: ["memory_list", "memory_read", "memory_write", "memory_delete"],
  },
  {
    id: "lessons",
    title: "项目复盘教训 (Lessons)",
    description: "查看、新增与清理沉淀到项目维度的历史避坑教训",
    toolNames: ["lesson_list", "lesson_add", "lesson_delete"],
  },
  {
    id: "routines",
    title: "周期例行任务与提醒 (Routines)",
    description: "创建、列举、暂停、恢复、立即执行或删除周期巡检与一次性提醒",
    toolNames: ["routine_list", "routine_create", "routine_manage"],
  },
  {
    id: "dag",
    title: "任务拆片、范围与返工 (DAG & Lifecycle)",
    description: "启动已解锁下游任务、修改任务范围、退回返工、撤回计划与兼容结项",
    toolNames: [
      "task_start_ready",
      "task_scope",
      "task_rework",
      "task_complete",
      "task_plan_withdraw",
    ],
  },
  {
    id: "settings",
    title: "配置审批卡提案 (Settings)",
    description: "向用户提议修改白名单内的主对话配置并生成原生审批卡",
    toolNames: ["settings_propose_patch"],
  },
  {
    id: "conversations",
    title: "方向主管与分支对话 (Conversations)",
    description: "创建、读写分支/方向主管对话、汇报方向阶段进度与升级拍板",
    toolNames: [
      "conversation_new",
      "conversation_send",
      "conversation_read",
      "leader_progress",
      "ask_escalate",
    ],
  },
];

const TOOL_NAME_TO_GROUP = new Map<string, MainChatToolGroupId>();
for (const name of MAIN_CHAT_CORE_TOOL_NAMES) {
  TOOL_NAME_TO_GROUP.set(name, "core");
}
for (const group of MAIN_CHAT_DEFERRED_TOOL_GROUPS) {
  for (const name of group.toolNames) {
    if (!TOOL_NAME_TO_GROUP.has(name)) {
      TOOL_NAME_TO_GROUP.set(name, group.id);
    }
  }
}

export function resolveMainChatToolGroup(
  toolName: string,
  options?: { isLeaderCaller?: boolean },
): MainChatToolGroupId {
  if (options?.isLeaderCaller && MAIN_CHAT_LEADER_CORE_TOOL_NAMES.includes(toolName)) {
    return "core";
  }
  return TOOL_NAME_TO_GROUP.get(toolName) ?? "core";
}

export interface MainChatToolLoaderSessionState {
  activeGroups: Set<MainChatToolGroupId>;
  activeToolNames: Set<string>;
}

export interface MainChatToolLoaderRegistry {
  getSessionState(callerAgentId: string): MainChatToolLoaderSessionState;
  activateGroups(
    callerAgentId: string,
    groups: readonly MainChatToolGroupId[],
  ): MainChatToolGroupId[];
  activateToolNames(callerAgentId: string, toolNames: readonly string[]): string[];
  clearSession(callerAgentId: string): void;
  resetAll(): void;
}

export function createMainChatToolLoaderRegistry(): MainChatToolLoaderRegistry {
  const byCaller = new Map<string, MainChatToolLoaderSessionState>();

  function getOrCreate(callerAgentId: string): MainChatToolLoaderSessionState {
    let state = byCaller.get(callerAgentId);
    if (!state) {
      state = {
        activeGroups: new Set<MainChatToolGroupId>(["core"]),
        activeToolNames: new Set<string>(),
      };
      byCaller.set(callerAgentId, state);
    }
    return state;
  }

  return {
    getSessionState(callerAgentId) {
      return getOrCreate(callerAgentId);
    },
    activateGroups(callerAgentId, groups) {
      const state = getOrCreate(callerAgentId);
      const newlyAdded: MainChatToolGroupId[] = [];
      for (const group of groups) {
        if (!state.activeGroups.has(group)) {
          state.activeGroups.add(group);
          newlyAdded.push(group);
        }
      }
      return newlyAdded;
    },
    activateToolNames(callerAgentId, toolNames) {
      const state = getOrCreate(callerAgentId);
      const newlyAdded: string[] = [];
      for (const name of toolNames) {
        const trimmed = name.trim();
        if (!trimmed) continue;
        if (!state.activeToolNames.has(trimmed)) {
          state.activeToolNames.add(trimmed);
          newlyAdded.push(trimmed);
        }
      }
      return newlyAdded;
    },
    clearSession(callerAgentId) {
      byCaller.delete(callerAgentId);
    },
    resetAll() {
      byCaller.clear();
    },
  };
}

export function extractToolInputJsonSchema(
  inputSchema: PaseoToolDefinition["inputSchema"],
): Record<string, unknown> {
  if (!inputSchema) {
    return { type: "object", properties: {} };
  }
  const zodSchema: z.ZodType =
    inputSchema instanceof z.ZodType
      ? inputSchema
      : z.object(inputSchema as Record<string, z.ZodType>);
  try {
    const jsonSchema = z.toJSONSchema(zodSchema, { unrepresentable: "any" });
    if (jsonSchema && typeof jsonSchema === "object") {
      return ensureValidJson(jsonSchema) as Record<string, unknown>;
    }
  } catch {
    // Fallback to minimal shape when a schema contains non-JSON-schema custom refinements
  }
  return { type: "object", properties: {} };
}

export interface SerializedToolDescriptor {
  name: string;
  group: MainChatToolGroupId;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function serializeToolDescriptor(
  tool: PaseoToolDefinition,
  options?: { isLeaderCaller?: boolean },
): SerializedToolDescriptor {
  return {
    name: tool.name,
    group: resolveMainChatToolGroup(tool.name, options),
    title: tool.title ?? tool.name,
    description: tool.description,
    inputSchema: extractToolInputJsonSchema(tool.inputSchema),
  };
}

export function measureToolManifestBytes(
  tools: ReadonlyMap<string, PaseoToolDefinition>,
  options?: { isLeaderCaller?: boolean },
): number {
  const descriptors: SerializedToolDescriptor[] = [];
  for (const tool of tools.values()) {
    descriptors.push(serializeToolDescriptor(tool, options));
  }
  return Buffer.byteLength(JSON.stringify(descriptors), "utf8");
}

export interface ApplyOnDemandToolLoadingInput {
  callerAgentId: string;
  isLeaderCaller: boolean;
  onDemandEnabled: boolean;
  candidates: ReadonlyMap<string, PaseoToolDefinition>;
  tools: Map<string, PaseoToolDefinition>;
  builtinNames: Set<string>;
  registry: MainChatToolLoaderRegistry;
  isToolAllowed: (name: string) => boolean;
  onToolsActivated?: (activatedTools: readonly PaseoToolDefinition[]) => void;
}

export function applyMainChatOnDemandToolLoading(input: ApplyOnDemandToolLoadingInput): void {
  const {
    callerAgentId,
    isLeaderCaller,
    onDemandEnabled,
    candidates,
    tools,
    builtinNames,
    registry,
    isToolAllowed,
    onToolsActivated,
  } = input;

  const sessionState = registry.getSessionState(callerAgentId);

  const isToolVisibleNow = (toolName: string): boolean => {
    if (!onDemandEnabled) return true;
    const group = resolveMainChatToolGroup(toolName, { isLeaderCaller });
    if (group === "core") return true;
    if (sessionState.activeGroups.has(group)) return true;
    return sessionState.activeToolNames.has(toolName);
  };

  for (const def of candidates.values()) {
    builtinNames.add(def.name);
    if (!isToolAllowed(def.name)) continue;
    if (isToolVisibleNow(def.name)) {
      tools.set(def.name, def);
    } else {
      tools.delete(def.name);
    }
  }

  const buildCatalogSummary = () => {
    const groups = MAIN_CHAT_DEFERRED_TOOL_GROUPS.map((group) => {
      const availableTools = group.toolNames
        .map((name) => candidates.get(name))
        .filter((def): def is PaseoToolDefinition => Boolean(def && isToolAllowed(def.name)));
      const loadedTools = availableTools.filter((def) => tools.has(def.name)).map((d) => d.name);
      return {
        id: group.id,
        title: group.title,
        description: group.description,
        loaded: availableTools.length > 0 && loadedTools.length === availableTools.length,
        loadedCount: loadedTools.length,
        totalCount: availableTools.length,
        tools: availableTools.map((def) => ({
          name: def.name,
          title: def.title ?? def.name,
          loaded: tools.has(def.name),
        })),
      };
    }).filter((entry) => entry.totalCount > 0);

    const coreTools = Array.from(candidates.values())
      .filter(
        (def) =>
          isToolAllowed(def.name) &&
          resolveMainChatToolGroup(def.name, { isLeaderCaller }) === "core",
      )
      .map((def) => ({
        name: def.name,
        title: def.title ?? def.name,
      }));

    return {
      onDemandToolLoading: onDemandEnabled,
      coreTools,
      groups,
      activeToolCount: tools.size,
      totalCandidateCount: candidates.size,
    };
  };

  const catalogTool: PaseoToolDefinition = {
    name: "tool_catalog",
    title: "Browse main-chat on-demand tool groups",
    description:
      "查看当前可用的按需工具分组目录（memory / lessons / routines / dag / settings / conversations）及加载状态，需要时再调用 tool_load 激活对应分组。",
    inputSchema: z.object({
      group: MainChatToolGroupIdSchema.optional().describe("可选：只查看指定工具分组的详情。"),
    }),
    async handler(rawInput) {
      const parsed = rawInput as { group?: MainChatToolGroupId };
      const summary = buildCatalogSummary();
      const filteredGroups = parsed.group
        ? summary.groups.filter((entry) => entry.id === parsed.group)
        : summary.groups;
      return addModelVisibleStructuredContent({
        content: [],
        structuredContent: ensureValidJson({
          ...summary,
          groups: filteredGroups,
          guidance: onDemandEnabled
            ? "调用 tool_load({ groups: [...] }) 或 tool_load({ tools: [...] }) 即可动态激活所需分组并获取精准参数 schema。"
            : "当前已关闭按需加载，所有主对话工具均已全量激活。",
        }),
      });
    },
  };

  const loadTool: PaseoToolDefinition = {
    name: "tool_load",
    title: "Dynamically load on-demand main-chat tool groups",
    description:
      "按需激活一个或多个延迟加载的工具分组（memory / lessons / routines / dag / settings / conversations）或指定工具名，使其立即对当前会话可见并返回精准参数 schema。",
    inputSchema: z.object({
      groups: z
        .array(MainChatToolGroupIdSchema)
        .max(8)
        .optional()
        .describe("要激活的工具分组 ID 列表，例如 ['memory', 'lessons']。"),
      tools: z
        .array(z.string().trim().min(1))
        .max(20)
        .optional()
        .describe("要单独激活的工具名称列表，例如 ['settings_propose_patch']。"),
      all: z.boolean().optional().describe("设为 true 时一次性激活所有剩余延迟工具分组。"),
    }),
    async handler(rawInput) {
      const parsed = rawInput as {
        groups?: MainChatToolGroupId[];
        tools?: string[];
        all?: boolean;
      };
      const targetGroups: MainChatToolGroupId[] = parsed.all
        ? MAIN_CHAT_DEFERRED_TOOL_GROUPS.map((g) => g.id)
        : (parsed.groups ?? []);
      const targetToolNames = parsed.tools ?? [];
      if (targetGroups.length === 0 && targetToolNames.length === 0) {
        throw new Error("请至少指定 groups、tools 或 all=true 之一");
      }

      const newlyActivatedGroups = registry.activateGroups(callerAgentId, targetGroups);
      const newlyActivatedNames = registry.activateToolNames(callerAgentId, targetToolNames);

      const requestedNameSet = new Set<string>(targetToolNames);
      for (const groupId of targetGroups) {
        const spec = MAIN_CHAT_DEFERRED_TOOL_GROUPS.find((entry) => entry.id === groupId);
        if (spec) {
          for (const toolName of spec.toolNames) {
            requestedNameSet.add(toolName);
          }
        }
      }

      const newlyRegistered: PaseoToolDefinition[] = [];
      const activatedDescriptors: SerializedToolDescriptor[] = [];
      const unknownTools: string[] = [];

      for (const toolName of requestedNameSet) {
        const def = candidates.get(toolName);
        if (!def || !isToolAllowed(def.name)) {
          if (targetToolNames.includes(toolName)) {
            unknownTools.push(toolName);
          }
          continue;
        }
        if (!tools.has(def.name)) {
          tools.set(def.name, def);
          newlyRegistered.push(def);
        }
        activatedDescriptors.push(serializeToolDescriptor(def, { isLeaderCaller }));
      }

      if (newlyRegistered.length > 0) {
        onToolsActivated?.(newlyRegistered);
      }

      return addModelVisibleStructuredContent({
        content: [],
        structuredContent: ensureValidJson({
          onDemandToolLoading: onDemandEnabled,
          newlyActivatedGroups,
          newlyActivatedToolNames: newlyRegistered.map((d) => d.name),
          requestedExtraToolNames: newlyActivatedNames,
          unknownTools,
          tools: activatedDescriptors,
          activeToolCount: tools.size,
          guidance:
            activatedDescriptors.length > 0
              ? `已激活 ${activatedDescriptors.length} 个工具（新增注册 ${newlyRegistered.length} 个），现在可直接按返回的参数 schema 调用。`
              : "未匹配到可激活的延迟工具。",
        }),
      });
    },
  };

  for (const loaderDef of [catalogTool, loadTool]) {
    builtinNames.add(loaderDef.name);
    if (isToolAllowed(loaderDef.name)) {
      tools.set(loaderDef.name, loaderDef);
    }
  }
}
