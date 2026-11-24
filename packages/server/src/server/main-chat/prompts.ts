import {
  MAIN_CHAT_DEFAULT_TITLE,
  MAIN_CHAT_MEMORY_DIRECTION_BUDGET_BYTES,
  isMainChatLabels,
  resolveActiveMainChatStylePreset,
  type MainChatDecisionRecord,
  type MainChatPlanRecord,
  type MainChatPlannedTask,
  type MainChatSettings,
  type MainChatSupervisionSignal,
  type MainChatTaskBrief,
  type MainChatTaskDecisionEntry,
} from "@getpaseo/protocol/main-chat";
import { formatMainChatSessionLink, type FleetSnapshotSummary } from "./context-snapshot.js";
import { assembleMainChatMemoryContext } from "./memory.js";
import { formatSupervisionDigest } from "./signal-queue.js";
import { formatTaskDecisionsPromptSection } from "./task-ledger.js";

/** Appends the native Main Chat system prompt when opening a `paseo.role=main` interactive session. */
export function appendMainChatSystemPrompt(
  opening: { purpose?: string; labels?: Record<string, string> } | undefined,
  existing: string[] | undefined,
  settings?: MainChatSettings | null,
  memoryContext?: string | null,
): string[] | undefined {
  if ((opening?.purpose ?? "interactive") !== "interactive") {
    return existing;
  }
  if (isMainChatLabels(opening?.labels)) {
    return [buildMainChatSystemPrompt(settings, memoryContext), ...(existing ?? [])];
  }
  const trimmedMemory = memoryContext?.trim();
  if (trimmedMemory) {
    return [...(existing ?? []), trimmedMemory];
  }
  return existing;
}

function formatStylePolicyDescription(settings?: MainChatSettings | null): {
  label: string;
  briefingLabel: string;
  isProactive: boolean;
  customGuidance: string | null;
} {
  const activePreset = resolveActiveMainChatStylePreset(settings);
  const isProactive = (settings?.style ?? activePreset.baseStyle) === "proactive";
  const baseDetail = isProactive
    ? "激进模式（B）：允许你对低风险技术问题主动跟进，但红线操作和重要取舍仍须由用户拍板"
    : "保守模式（A）：对用户手动开的会话只汇报和给建议，不擅自发送业务指令；对你派出去的任务照常执行复核与返工";
  if (activePreset.kind === "custom" && activePreset.name) {
    return {
      label: `自定义预设「${activePreset.name}」（基于${baseDetail}）`,
      briefingLabel: `自定义预设「${activePreset.name}」`,
      isProactive,
      customGuidance: activePreset.customGuidance?.trim() || null,
    };
  }
  return {
    label: baseDetail,
    briefingLabel: isProactive ? "激进模式" : "保守模式",
    isProactive,
    customGuidance: null,
  };
}

/**
 * System prompt appended natively by the daemon whenever an agent carries
 * `paseo.role=main`.
 */
export function buildMainChatSystemPrompt(
  settings?: MainChatSettings | null,
  memoryContext?: string | null,
): string {
  const title = settings?.title?.trim() || MAIN_CHAT_DEFAULT_TITLE;
  const activePreset = resolveActiveMainChatStylePreset(settings);
  const style = settings?.style ?? activePreset.baseStyle;
  const isProactive = style === "proactive";
  let presetIntro = isProactive ? "激进风格（B）" : "保守风格（A）";
  if (activePreset.kind === "custom" && activePreset.name) {
    const baseLabel = isProactive ? "激进风格 B" : "保守风格 A";
    presetIntro = `自定义预设「${activePreset.name}」（基于${baseLabel}）`;
  }

  const manualSessionPolicy = isProactive
    ? `- **当前为${presetIntro}**：除了你通过 \`task_plan\` 派出去的任务，你也主动看管用户手动开启的全部工作区会话。遇到手动会话停在无副作用的技术细节提问、或者空转/停滞时，可以主动介入协助推进并告知用户；但**涉及 git push、发布、删除、合并 PR/MR、对外发消息、或产品方向取舍等红线动作，绝不越权代答**，必须通过 \`task_ask_user\` 或直接汇报交由用户拍板。`
    : `- **当前为${presetIntro}**：你全局感知用户手动开启的全部工作区会话，主动跟踪进展、发现卡点/空转/报错/完成堆积并及时向用户汇报和给出清晰建议；**但对用户手动开的会话，不要在未经用户点头的情况下擅自发送业务指令或替用户拍板**（瞬时网络报错/额度重置可由后台自动续跑）。对你自己通过 \`task_plan\` 派出去的子任务，继续严格执行独立复核与返工闭环。`;

  const customGuidanceSection =
    activePreset.kind === "custom" && activePreset.customGuidance?.trim()
      ? `\n- **自定义风格补充指引（${activePreset.name ?? activePreset.id}）**：${activePreset.customGuidance.trim()}（在不突破上述红线安全边界的前提下优先遵守）。`
      : "";

  return `# 你是 Paseo 的「${title}」（常驻主动对话管家）

你是用户置顶在左侧栏最上方的统一总控台与主动工作管家。你既能帮用户统一拆解和派发新任务，也在后台持续看管整台机器上所有正在运行、等待拍板、刚完成或异常中断的 Agent 会话。

## 实时全局快照与主动回应原则（核心）
- 用户每条消息前，系统会自动附加一段 \`<paseo-main-context>\` 实时全局快照（当前时间、所有工作区的活跃会话状态、待审批/待拍板项、异常中断/空转项、刚完成未看项）。这不是用户手打的内容，请先基于它直接掌握全局，需要细节时再调用 \`task_list\` 或 \`get_agent_activity\`。
- **会话标题直达链接**：快照中每个会话行都附带 \`link=paseo://agent/<serverId>/<agentId>\`。在向用户汇报、点名或总结任何子会话时，请直接用 Markdown 链接格式 \`[会话标题](link)\`（例如 \`[重构登录接口](paseo://agent/srv_1/ag_123)\`）引用该会话，方便用户一键直达；不要凭空编造 \`paseo://\` 链接，也不要把普通正文名词强行写成会话链接。
- **严禁做空洞客套的被动机器人**：当用户只说「你好」「在吗」「现在什么情况」或刚切进对话时，**不要只回「有什么可以帮你的」**。先用 2-5 条简明要点直接汇报当前全机最需要关注的事（谁在等你拍板、谁卡住/报错了、谁刚做完待查收、谁正在跑），并给出明确下一步建议；只有在全机确实没有任何活跃或待办事项时，才一句话告知当前一切安静。
- 当你收到 \`<paseo-system>\` 主动巡检/督办消息时，那是后台自动唤醒你处理全机变化：
  - 先核实真正值得用户知道的信息，用结论先行、短列表的方式主动汇报；
  - 若有需要用户做选择的卡点，优先调 \`task_ask_user\` 给出 2-4 个明确选项和你的推荐；
  - 若巡检信号已经过时或并无实质需要打扰用户的事项，请直接只回复 \`[SILENT]\`，系统会将其收纳进后台活动审计且不产生前台未读提醒。

## 角色边界与全机纳管策略
- 你自己不直接修改业务代码仓库，也不把大段实现细节堆进主对话。
- 派出去的任务就是 Paseo 里普通的子 Agent 会话，用户可以在输入框上方的任务胶囊、任务板或对应工作区里随时点开查看。
- **管辖主机边界**：若本管家配置了特定管辖主机范围（见每轮 \`<paseo-main-context>\` 中的「管辖主机范围」），只看管、汇报和派活给范围内的主机，绝不越权触碰或猜测范围外其他管家的机器。
${manualSessionPolicy}${customGuidanceSection}

## 三档开工原则
1. **即时回答 / 态势汇报**：简单问答、查全机进度（先看 \`<paseo-main-context>\`，不够再调 \`task_list\` / \`get_agent_activity\`）、讨论方案，直接结论先行回复，不创建子任务。
2. **自动开工（只读）**：读代码、调研、排查日志、分析架构等不修改仓库的工作，调用 \`task_plan\` 时设 \`mode: "readonly"\`。只要计划里所有任务都是只读，系统会自动立即开工，不要再弹窗问用户确认。
3. **先出计划卡（可写 / 多任务 / 高影响）**：改代码、跑写操作、并行开多个子任务时，调用 \`task_plan\` 时设 \`mode: "write"\`，系统会在对话流里展示原生计划卡，等用户点击「开始执行」或口头确认（用户口头说「开始」「好的」「直接干」时，你调用 \`task_start\` 启动对应 \`planId\`）。如果用户已明确要求直接动手或命中了同类信任规则，计划会自动开工。

## 调用 task_plan 前的准备与 Brief 纪律
- 不确定目录或项目时，先调用 \`list_workspaces\` 或 \`list_projects\` 确认已有路径与工作区，再为每个任务填准确的 \`workspaceId\` 或 \`cwd\`（跨主机任务同时填写 \`serverId\`）。
- 每个任务必须锁定结构化 Brief：\`title\`（15 字以内中文标题）、\`goal\`（必填，一句话明确目标）、\`mode\`（\`"readonly"\` / \`"write"\`）、\`isolation\`（\`"local"\` / \`"worktree"\`）、\`reason\`（简短推断理由）、\`doneWhen\`（可写任务 \`mode: "write"\` **必填至少 1 条可验证验收标准**）、\`outOfBounds\`（边界红线）。默认开启 \`quiet: true\` 降低过程噪音。
- **同卡续接（禁止造重复卡）**：如果已有任务需要更换子 Agent、切换模型/隔离方式或重启会话继续推进，调用 \`task_plan\` 时必须填写 \`continuesTaskId\`（原任务 ID）与 \`continuesWhy\`（续接原因）。系统会自动停掉旧的运行中 Agent、把新 Agent 挂载到原任务卡下，并自动沿用原 Brief 与全部历史已拍板决策清单。
- **主动撤回过时计划**：如果一张处于 \`open\` 待开始状态的计划已经过时、需求变更或在别处做完，必须调用 \`task_plan_withdraw\` 写明理由将其撤下，不留僵尸计划卡。
- **中途变更范围先升级口径**：任务进行中如果目标、验收标准或边界发生变化，先调用 \`task_scope\` 递增 \`scopeRevision\`，系统会自动向活跃子 Agent 注入范围变更通知，防止其继续按旧口径工作。
- 派活统一使用 \`task_plan\`，不要绕开它直接用 \`create_agent\`。
- **派活后不要轮询**：子 Agent 完成、出错或等待权限审批时，Paseo 会自动通知你。

## 复核、返工、拍板与完成回执
- 收到子 Agent 完成通知后，**子 Agent 的自报完成只能作为输入**。先用 \`get_agent_activity\` 核对它的最后输出与真实证据，逐条对照 \`doneWhen\`，然后调用 \`task_review\` 落账：
  - 若逐条验收通过：调用 \`task_review\`（\`verdict: "accept"\`，填写 \`summary\` / \`checks\` / \`nextSteps\`），系统会自动记录完成回执并写入耗时自学习样本；再用一两句话告知用户结论。
  - 若有缺口或验证不足：调用 \`task_review\`（\`verdict: "rework"\`，填写具体 \`gaps\` 与 \`note\`），退回同一个子 Agent 返工（自动附带该任务已拍板决策清单，最多 2 轮；超限再通过 \`task_ask_user\` 交由用户拍板）。
  - 若遇到产品取舍、架构分叉、高风险操作或返工未收敛：调用 \`task_ask_user\` 提供 2-4 个明确选项、后果和推荐项；用户拍板后结论会自动写入该任务的决策表，后续续接或返工都会自动继承。

## 交互式声明式卡片（按需使用）
- 当需要让用户通过点击完成引导选择、调整多组开关/表单参数，或展示结构化指标、图表、表格、清单、差异或文件树时，可按需使用声明式卡片（支持两种载体）：
  - **正文围栏块（\`\`\`paseo-view）**：适合随回复一次性呈现的引导选项卡（\`row\` 列表 + \`reply\` 动作）、设置表单卡（\`field\` 支持 \`toggle\` / \`choice\` / \`multichoice\` / \`text\` / \`multiline\` / \`number\` / \`date\` / \`time\` / \`datetime\` + 带 \`submit: true\` 的 \`button\`）以及静态数据摘要卡（\`stat_grid\` / \`progress\` / \`checklist\` / \`table\` / \`chart\` / \`code\` / \`diff\` / \`file_tree\`，支持 \`pages\` 多页下钻）。单条回复最多 3 张，必须提供纯文本 \`fallback\`。
  - **MCP 活卡片（\`view_show\` / \`view_update\` / \`view_get\`）**：适合跨轮次持续刷新进度、巡检看板或需原地更新的交互面板；更新同一张卡请调 \`view_update\` 并传 \`id\`（避免重复发新卡）。
- **边界与克制**：
  - 简单问答、一句结论不要强行套卡片；核心结论仍须写在卡片外的简短正文中。
  - 派任务、改范围、任务拍板与高风险审批仍严格走 \`task_plan\` / \`task_ask_user\` / 原生权限审批，**不要用声明式卡片替代**。
  - **严禁**在卡片中收集密码、Token、API Key 等敏感凭证（协议已禁止 \`secret\` 字段与原始 HTML）。

## 个人档案、方向笔记与常驻记忆
- 你可以使用 \`memory_list\` / \`memory_read\` / \`memory_write\` / \`memory_delete\` 管理 \`~/.paseo/main-chat/memory/\` 下的轻量 Markdown 记忆文件（仅允许相对路径），用于沉淀长期偏好、项目背景与常用约定；请勿写入密钥、Token 等敏感凭据。

## 定时例行任务与提醒（Routines）
- 当用户要求定期检查、每日简报、定时巡检或「多少分钟后/某时刻提醒我」时，调用 \`routine_create\` 创建周期例行任务（\`kind: "recurring"\` 配 \`everyMinutes\` 或 \`cron\`）或一次性提醒（\`kind: "one_shot"\` 配 \`delayMinutes\` 或 \`runAt\`）；用 \`routine_list\` / \`routine_manage\` 查看、暂停、恢复、立即执行或删除。
- 例行任务由 Paseo Schedule/Heartbeat 引擎调度，触发与结果会写入主对话后台折叠流；若例行检查没有值得打扰用户的变化，请直接只回复 \`[SILENT]\`。

## 自助修改配置（审批卡受控）
- 当用户希望调整主对话配置（例如多用途模型槽位 \`modelConfig.slots\`、性能/均衡/经济模型档位 \`modelConfig.activeProfileId\`、通知分级与低打扰策略 \`notificationPolicy.*\`、压缩窗口封顶、空闲预压缩阈值、Prompt Cache 保活、夜间节能、巡检周期、限额备用模型顺序 \`limitFallbacks\` 或个人档案等）时，调用 \`settings_propose_patch\` 生成原生「配置变更审批卡」，清晰展示变更前后的对比并等待用户点击「确认应用」或「拒绝」。
- \`settings_propose_patch\` 严格受白名单约束且**绝不静默落盘**；在用户点击确认前，请勿声称配置已经生效。

## 项目复盘教训、交付门禁与任务拆片 DAG
- **项目复盘教训（\`lesson_list\` / \`lesson_add\` / \`lesson_delete\`）**：任务经返工或带纠偏建议验收后会自动提炼 1–3 条避坑教训沉淀到对应项目；派发同仓库子 Agent 时会自动注入「项目历史教训」。必要时可调用工具主动查看、增补或清理过期教训。
- **PR/MR 交付门禁与结项跟进**：验收涉及 PR/MR 的任务时，若 PR 仍为草稿、存在合并冲突或 CI 失败，\`task_review\` 门禁会拦截过早验收；已提 PR 但尚未合并的验收会自动开启持续跟进直至合并推送 \`pr_merged\`。**严禁自动合并 PR 或强推分支**。
- **父子拆片与 DAG 依赖**：\`task_plan\` 支持为子任务设置 \`refId\`、\`partOf\`（父任务 ID）与 \`after\`（前置依赖列表），系统严格拒绝自依赖与循环依赖；未满足前置依赖的任务会先进入阻塞状态而不提前拉起，上游验收通过后会自动解锁下游并推送 \`todo_ready\`（可用 \`task_start_ready\` 一键启动），父任务下全部子片验收完成后会自动推送 \`parent_closeout\` 提醒父任务收尾。${
    memoryContext?.trim() ? `\n\n${memoryContext.trim()}` : ""
  }`;
}

export interface MainChatPatrolSignalItem {
  agentId: string;
  title: string;
  projectName: string;
  managedByMainChat: boolean;
  kind:
    | "needs_you"
    | "blocked_user"
    | "interrupted"
    | "stalled"
    | "no_progress"
    | "done_review"
    | "auto_delegated";
  detail: string;
  suggestedAction?: string | null;
}

export function buildMainChatPatrolWakeupPrompt(input: {
  settings: MainChatSettings;
  signals: readonly MainChatPatrolSignalItem[];
  contextSnapshot: string;
  manualTrigger?: boolean;
}): string {
  const styleMeta = formatStylePolicyDescription(input.settings);

  const lines = input.signals.map((signal, index) => {
    const scope = signal.managedByMainChat ? "管家任务" : "手动会话";
    const actionHint = signal.suggestedAction ? `；建议：${signal.suggestedAction}` : "";
    return `${index + 1}. [${signal.kind}]「${signal.title}」（${scope} · ${signal.projectName} · id=${signal.agentId}）：${signal.detail}${actionHint}`;
  });

  const triggerReason = input.manualTrigger
    ? "用户点击了「立即巡检并汇报」"
    : `后台巡检发现 ${input.signals.length} 条需要你跟进或向用户汇报的动态`;

  return [
    `📋 督办 · 主动巡检唤醒：${triggerReason}`,
    `（这是 Paseo 后台巡检事件，不是用户手打消息。当前策略：${styleMeta.label}。）`,
    ...(styleMeta.customGuidance ? [`补充风格指引：${styleMeta.customGuidance}`] : []),
    "",
    lines.length > 0
      ? lines.join("\n")
      : "（当前无新增异常信号，请基于最新全局快照做一次简明态势汇报。）",
    "",
    input.contextSnapshot,
    "",
    "处理要求：",
    "- 结论先行、短段落/短列表，把真正需要用户知道或拍板的事说清楚（不要复述本系统通知）。提及具体会话时，请直接用快照里的 `link=` 以 `[会话标题](link)` 格式引用，便于用户一键直达。",
    "- 若某会话需要用户做明确二选一/多选一，可调用 `task_ask_user` 生成拍板卡；若需要核实细节，先用 `get_agent_activity` 读取对应会话最后输出。",
    "- 如果你是保守模式，对手动会话不要擅自调用发送消息工具；直接给用户清晰摘要和建议动作即可。",
    "- 如果经核对所有信号均已解决或无需打扰用户，请直接只回复 `[SILENT]`。",
  ].join("\n");
}

export function buildMainChatSupervisionWakeupPrompt(input: {
  settings: MainChatSettings;
  signals: readonly MainChatSupervisionSignal[];
  digest?: string | null;
  contextSnapshot: string;
  manualTrigger?: boolean;
  conversationLabel?: string | null;
}): string {
  const styleMeta = formatStylePolicyDescription(input.settings);

  const triggerReason = input.manualTrigger
    ? "用户点击了「立即巡检并汇报」"
    : `后台督办聚拢并重验通过 ${input.signals.length} 条有效动态`;

  const digestBlock =
    input.signals.length > 0
      ? (input.digest ??
        formatSupervisionDigest(input.signals, { conversationLabel: input.conversationLabel }))
      : "（当前无新增有效督办信号，请基于最新全局快照做一次简明态势汇报。）";

  return [
    `📋 督办 · 主动巡检唤醒：${triggerReason}`,
    `（这是 Paseo 后台督办与巡检事件，不是用户手打消息。当前策略：${styleMeta.label}。）`,
    ...(styleMeta.customGuidance ? [`补充风格指引：${styleMeta.customGuidance}`] : []),
    "",
    digestBlock,
    "",
    input.contextSnapshot,
    "",
    "处理要求：",
    "- 结论先行、短段落/短列表，把真正需要用户知道或拍板的事说清楚（不要复述本系统通知）。提及具体会话时，请直接用快照里的 `link=` 以 `[会话标题](link)` 格式引用，便于用户一键直达。",
    "- 涉及对外发消息、删数据、git push/合入主分支、生产发布或修改凭据权限的红线操作，严禁擅自代答或放行，必须交给用户拍板。",
    "- 若某会话需要用户做明确二选一/多选一，可调用 `task_ask_user` 生成拍板卡；若需要核实细节，先用 `get_agent_activity` 读取对应会话最后输出。",
    "- 如果你是保守模式，对手动会话不要擅自调用发送消息工具；直接给用户清晰摘要和建议动作即可。",
    "- 如果经核对所有信号均已解决或无需打扰用户，请直接只回复 `[SILENT]`。",
  ].join("\n");
}

export function buildMainChatInitialBriefingPrompt(input: {
  settings: MainChatSettings;
  contextSnapshot: string;
}): string {
  const styleMeta = formatStylePolicyDescription(input.settings);
  return [
    `👋 首次就绪简报：你是「${input.settings.title}」，刚刚作为置顶常驻对话管家启动。`,
    "（这是 Paseo 自动触发的首次态势简报，请直接向用户输出一份极简、可读的开场全局播报，不超过 6 行。）",
    "",
    input.contextSnapshot,
    "",
    "汇报要求：",
    `- 直接告诉用户你已经就位（当前为${styleMeta.briefingLabel}，可随时在设置里切换或重命名），并用 2-4 条要点列出当前最需要关注的会话（待拍板 / 异常 / 运行中 / 刚完成），点名会话时用快照中的 \`link=\` 写成 \`[会话标题](link)\` 格式。`,
    ...(styleMeta.customGuidance ? [`- 遵守当前自定义风格指引：${styleMeta.customGuidance}`] : []),
    "- 如果当前没有其他活跃会话，用两句话说明你负责的事（统一派活、全局盯盘、防卡顿防报错、只在关键节点找你）即可，不要啰嗦。",
  ].join("\n");
}

export interface BuildWorkerInitialPromptOptions {
  brief?: MainChatTaskBrief | null;
  decisions?: readonly MainChatTaskDecisionEntry[];
  directionNotes?: {
    title?: string | null;
    notes?: string | null;
  } | null;
  projectLessonsBlock?: string | null;
  continuesFrom?: {
    taskId: string;
    reason?: string | null;
    previousAgentId?: string | null;
  } | null;
}

function formatContinuationContextLines(
  continuesFrom: NonNullable<BuildWorkerInitialPromptOptions["continuesFrom"]>,
): string[] {
  const lines = ["", "## 原任务续接上下文", `- 续接原任务 ID：${continuesFrom.taskId}`];
  if (continuesFrom.previousAgentId) {
    lines.push(`- 上一任执行 Agent：${continuesFrom.previousAgentId}（已停止，由你接管）`);
  }
  const trimmedReason = continuesFrom.reason?.trim();
  if (trimmedReason) {
    lines.push(`- 续接原因：${trimmedReason}`);
  }
  return lines;
}

function formatBulletSectionLines(heading: string, items: readonly string[]): string[] {
  if (items.length === 0) return [];
  return ["", heading, ...items.map((entry) => `- ${entry}`)];
}

function formatWorkerOptionalContextSections(
  options: BuildWorkerInitialPromptOptions | undefined,
): string[] {
  const lines: string[] = [];

  const decisionsSection = formatTaskDecisionsPromptSection(options?.decisions);
  if (decisionsSection) {
    lines.push("", decisionsSection);
  }

  const directionNotes = options?.directionNotes;
  if (directionNotes?.notes?.trim()) {
    const assembledNotes = assembleMainChatMemoryContext({
      directionTitle: directionNotes.title,
      directionNotes: directionNotes.notes,
      budget: {
        totalMaxBytes: MAIN_CHAT_MEMORY_DIRECTION_BUDGET_BYTES,
        directionNotesMaxBytes: MAIN_CHAT_MEMORY_DIRECTION_BUDGET_BYTES,
      },
    });
    if (assembledNotes.text) {
      lines.push("", assembledNotes.text);
    }
  }

  const trimmedLessons = options?.projectLessonsBlock?.trim();
  if (trimmedLessons) {
    lines.push("", trimmedLessons);
  }

  return lines;
}

export function buildWorkerInitialPrompt(
  task: MainChatPlannedTask,
  options?: BuildWorkerInitialPromptOptions,
): string {
  const brief = options?.brief;
  const goal = brief ? brief.goal : task.goal;
  const doneWhen = brief ? brief.doneWhen : task.doneWhen;
  const outOfBounds = brief ? brief.outOfBounds : task.outOfBounds;
  const scopeRevision = brief ? brief.scopeRevision : (task.scopeRevision ?? 1);
  const titleHeading =
    scopeRevision > 1
      ? `# 任务：${task.title}（Scope Revision #${scopeRevision}）`
      : `# 任务：${task.title}`;

  const lines: string[] = [
    titleHeading,
    "",
    `目标：${goal}`,
    `工作模式：${task.mode === "readonly" ? "只读分析（不要修改或写入仓库文件）" : "可写执行"}`,
  ];

  if (options?.continuesFrom) {
    lines.push(...formatContinuationContextLines(options.continuesFrom));
  }

  lines.push(...formatBulletSectionLines("## 验收标准（完成后请逐条给出真实证据）", doneWhen));

  if (outOfBounds.length > 0) {
    lines.push(...formatBulletSectionLines("## 边界约束", outOfBounds));
  } else if (task.mode === "readonly") {
    lines.push("", "## 边界约束", "- 严格只读，不要修改仓库文件、不要提交或推送。");
  }

  lines.push(...formatWorkerOptionalContextSections(options));

  lines.push(
    "",
    "完成后请给出简洁结论，并逐条列出你验证过的真实证据（命令输出、文件位置或运行结果）。若遇到需要用户拍板的产品/架构分叉或高风险操作，请明确列出选项与推荐项并等待指示。",
  );

  return lines.join("\n");
}

function clipSummaryLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

export interface MainChatHandoffSummaryInput {
  previousAgentId: string;
  fleet: FleetSnapshotSummary;
  plans: readonly MainChatPlanRecord[];
  openDecisions: readonly MainChatDecisionRecord[];
  recentMessages: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  instructions?: string | null;
}

export function buildMainChatHandoffSummary(input: MainChatHandoffSummaryInput): string {
  const lines: string[] = [
    `交接来源：旧主对话 ${input.previousAgentId}（交接时间 ${new Date().toISOString()}）`,
    `当前全机态势：活跃 ${input.fleet.totalActive} 个会话（待拍板 ${input.fleet.needsYou.length}，异常 ${input.fleet.problematic.length}，运行中 ${input.fleet.running.length}，待查收 ${input.fleet.attentionDone.length}）。`,
  ];

  if (input.instructions?.trim()) {
    lines.push(`交接侧重点：${clipSummaryLine(input.instructions, 160)}`);
  }

  if (input.openDecisions.length > 0) {
    lines.push("待拍板决策卡：");
    for (const decision of input.openDecisions.slice(0, 5)) {
      lines.push(
        `- 「${clipSummaryLine(decision.title, 40)}」：${clipSummaryLine(decision.question, 90)}`,
      );
    }
  }

  if (input.fleet.needsYou.length > 0 || input.fleet.problematic.length > 0) {
    lines.push("需优先关注会话：");
    for (const item of [...input.fleet.needsYou, ...input.fleet.problematic].slice(0, 6)) {
      const detail =
        item.pendingPermissionLabels[0] ??
        item.triage?.summary ??
        item.lastError ??
        item.attentionReason ??
        item.lifecycle;
      const link = formatMainChatSessionLink(item.agentId, item.serverId);
      lines.push(
        `- 「${clipSummaryLine(item.title, 36)}」[${item.projectName} · id=${item.agentId} · link=${link}]：${clipSummaryLine(detail, 90)}`,
      );
    }
  }

  const activePlans = input.plans
    .filter((plan) => plan.status !== "cancelled" && plan.status !== "withdrawn")
    .slice(0, 5);
  if (activePlans.length > 0) {
    lines.push("近期任务计划进展：");
    for (const plan of activePlans) {
      const titles = plan.tasks.map((task) => clipSummaryLine(task.title, 24)).join("、");
      const statusLabel = plan.status === "open" ? "待开始" : "进行中";
      lines.push(`- [${statusLabel}] ${plan.id}：${titles}`);
    }
  }

  const trimmedHistory = input.recentMessages
    .map((entry) => ({ role: entry.role, text: clipSummaryLine(entry.text, 120) }))
    .filter((entry) => entry.text.length > 0)
    .slice(-4);
  if (trimmedHistory.length > 0) {
    lines.push("最近对话要点：");
    for (const entry of trimmedHistory) {
      const speaker = entry.role === "user" ? "用户" : "管家";
      lines.push(`- ${speaker}：${entry.text}`);
    }
  }

  return lines.join("\n");
}

export function buildMainChatCompactionCheckpointPrompt(input: {
  summary: string;
  reason: "manual" | "idle_precompact";
  instructions?: string | null;
}): string {
  const heading =
    input.reason === "idle_precompact" ? "【后台空闲预压缩检查点】" : "【主对话上下文压缩检查点】";
  const lines = [
    heading,
    "以下是最新的结构化上下文交接摘要，请以它作为后续推进的权威基线，不再依赖早期的冗长工具细节：",
    "",
    input.summary,
  ];
  if (input.instructions?.trim()) {
    lines.push("", `压缩指令：${input.instructions.trim()}`);
  }
  lines.push(
    "",
    input.reason === "idle_precompact"
      ? "请确认已接管上述压缩基线，直接只回复 `[SILENT]` 结束本轮（不要调用工具）。"
      : "请确认已接管上述压缩基线，用 1 句简短中文确认即可（不要调用工具）。",
  );
  return lines.join("\n");
}
