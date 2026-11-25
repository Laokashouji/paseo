import type { FeishuNotificationCategory, FeishuNotificationTier } from "../shared/contracts.js";

export interface FeishuCard2 {
  schema: "2.0";
  config: {
    update_multi: boolean;
    summary?: { content: string };
  };
  header: {
    title: { tag: "plain_text"; content: string };
    subtitle?: { tag: "plain_text"; content: string };
    template: "blue" | "green" | "orange" | "red" | "grey" | "wathet";
    text_tag_list?: Array<{
      tag: "text_tag";
      text: { tag: "plain_text"; content: string };
      color: "blue" | "green" | "orange" | "red" | "neutral" | "wathet";
    }>;
  };
  body: {
    elements: Array<Record<string, unknown>>;
  };
}

function clipText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(1, maxChars - 1))}…`;
}

function escapeMarkdownInline(value: string): string {
  return value.replaceAll("`", "'").replaceAll("\r\n", "\n");
}

function plainText(content: string) {
  return { tag: "plain_text" as const, content };
}

function markdownBlock(content: string): Record<string, unknown> {
  return { tag: "markdown", content };
}

function noteBlock(content: string): Record<string, unknown> {
  return {
    tag: "div",
    text: {
      tag: "plain_text",
      content,
      text_size: "notation",
      text_color: "grey",
    },
  };
}

function callbackButton(
  label: string,
  style: "primary" | "default" | "danger",
  value: Record<string, string>,
): Record<string, unknown> {
  return {
    tag: "button",
    text: plainText(clipText(label, 48)),
    type: style,
    behaviors: [
      {
        type: "callback",
        value,
      },
    ],
  };
}

function buttonRow(buttons: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "8px",
    columns: buttons.map((button) => ({
      tag: "column",
      width: "auto",
      elements: [button],
    })),
  };
}

const CATEGORY_LABELS: Record<FeishuNotificationCategory, string> = {
  permission_approval: "权限审批",
  decision_required: "待拍板决策",
  task_failed: "任务失败",
  delivery_gate_blocked: "交付门禁阻断",
  task_review: "结果待验收",
  task_progress: "任务进展",
  rule_diagnostic: "规则诊断",
  patrol_summary: "巡检汇总",
};

const TIER_LABELS: Record<FeishuNotificationTier, string> = {
  critical: "关键必达",
  actionable: "可行动",
  digest: "摘要",
  silent: "静默",
};

export interface BuildPermissionCardInput {
  agentId: string;
  serverId: string | null;
  requestId: string;
  title: string;
  toolName: string;
  command: string | null;
  description: string | null;
  managed: boolean;
  isRedLine: boolean;
  redLineReason: string | null;
  actionPrefix: string;
}

export function buildPermissionApprovalCard(input: BuildPermissionCardInput): FeishuCard2 {
  const headerTitle = input.isRedLine
    ? `红线权限审批 · ${clipText(input.title, 44)}`
    : `权限审批 · ${clipText(input.title, 48)}`;
  const lines: string[] = [
    `**目标会话**：${escapeMarkdownInline(clipText(input.title, 80))}`,
    `**请求工具**：\`${escapeMarkdownInline(clipText(input.toolName, 64))}\``,
  ];
  if (input.command) {
    lines.push(`**执行命令**：\`${escapeMarkdownInline(clipText(input.command, 220))}\``);
  }
  if (input.description) {
    lines.push(`**说明**：${escapeMarkdownInline(clipText(input.description, 260))}`);
  }
  if (input.isRedLine && input.redLineReason) {
    lines.push(`**红线告警**：${escapeMarkdownInline(clipText(input.redLineReason, 220))}`);
  }

  const baseValue: Record<string, string> = {
    a: "perm",
    agent_id: input.agentId,
    request_id: input.requestId,
    managed: input.managed ? "1" : "0",
    title: clipText(input.title, 60),
  };
  if (input.serverId) {
    baseValue.server_id = input.serverId;
  }

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: clipText(`[Paseo] ${headerTitle}`, 60) },
    },
    header: {
      title: plainText(headerTitle),
      subtitle: plainText("Paseo 对话管理 · 保守模式 A 仅回写审批结果"),
      template: input.isRedLine ? "red" : "orange",
      text_tag_list: [
        {
          tag: "text_tag",
          text: plainText(input.isRedLine ? "高危红线" : "待审批"),
          color: input.isRedLine ? "red" : "orange",
        },
        {
          tag: "text_tag",
          text: plainText(input.managed ? "受管子任务" : "手动会话"),
          color: "neutral",
        },
      ],
    },
    body: {
      elements: [
        markdownBlock(lines.join("\n")),
        { tag: "hr" },
        buttonRow([
          callbackButton("批准执行", "primary", {
            ...baseValue,
            decision: "allow",
            action_id: `${input.actionPrefix}:allow`,
          }),
          callbackButton("拒绝请求", "danger", {
            ...baseValue,
            decision: "deny",
            action_id: `${input.actionPrefix}:deny`,
          }),
        ]),
        noteBlock("仅白名单 Open ID 可触发审批回写；点击后卡片将自动更新为终态。"),
      ],
    },
  };
}

export interface BuildDecisionCardInput {
  decisionId: string;
  title: string;
  question: string;
  options: ReadonlyArray<{ id: string; label: string; leadsTo: string }>;
  recommendedOptionId: string | null;
  reason: string | null;
  actionPrefix: string;
}

export function buildDecisionCard(input: BuildDecisionCardInput): FeishuCard2 {
  const headerTitle = `待拍板决策 · ${clipText(input.title, 46)}`;
  const lines: string[] = [`**决策问题**：${escapeMarkdownInline(clipText(input.question, 300))}`];
  if (input.reason) {
    lines.push(`**背景原因**：${escapeMarkdownInline(clipText(input.reason, 220))}`);
  }
  const visibleOptions = input.options.slice(0, 6);
  if (visibleOptions.length > 0) {
    lines.push("**可选方案**：");
    for (const option of visibleOptions) {
      const recMark = option.id === input.recommendedOptionId ? "（推荐）" : "";
      lines.push(
        `- **${escapeMarkdownInline(clipText(option.label, 48))}**${recMark}：${escapeMarkdownInline(clipText(option.leadsTo, 120))}`,
      );
    }
  }

  const buttons = visibleOptions.map((option) =>
    callbackButton(
      option.id === input.recommendedOptionId ? `${option.label}（推荐）` : option.label,
      option.id === input.recommendedOptionId ? "primary" : "default",
      {
        a: "decide",
        decision_id: input.decisionId,
        option_id: option.id,
        answer: clipText(option.label, 120),
        title: clipText(input.title, 60),
        action_id: `${input.actionPrefix}:${option.id}`,
      },
    ),
  );

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: clipText(`[Paseo] ${headerTitle}`, 60) },
    },
    header: {
      title: plainText(headerTitle),
      subtitle: plainText("Paseo 对话管理 · 点击按钮即可完成拍板"),
      template: "orange",
      text_tag_list: [
        {
          tag: "text_tag",
          text: plainText("待拍板"),
          color: "orange",
        },
      ],
    },
    body: {
      elements: [
        markdownBlock(lines.join("\n")),
        { tag: "hr" },
        buttonRow(buttons),
        noteBlock("拍板后仅向受管主对话/子任务回写本次选项，绝不向手动会话擅自下发业务命令。"),
      ],
    },
  };
}

export interface BuildNotificationCardInput {
  category: FeishuNotificationCategory;
  tier: FeishuNotificationTier;
  title: string;
  summary: string;
  reason: string | null;
  passthrough: boolean;
}

function resolveNotificationTemplate(
  category: BuildNotificationCardInput["category"],
  tier: BuildNotificationCardInput["tier"],
): FeishuCard2["header"]["template"] {
  if (category === "task_failed" || category === "delivery_gate_blocked") {
    return "red";
  }
  if (tier === "critical") return "orange";
  if (tier === "actionable") return "blue";
  return "wathet";
}

function resolveNotificationTagColor(
  template: FeishuCard2["header"]["template"],
): "red" | "orange" | "blue" {
  if (template === "red") return "red";
  if (template === "orange") return "orange";
  return "blue";
}

export function buildNotificationCard(input: BuildNotificationCardInput): FeishuCard2 {
  const categoryLabel = CATEGORY_LABELS[input.category];
  const tierLabel = TIER_LABELS[input.tier];
  const template = resolveNotificationTemplate(input.category, input.tier);

  const lines: string[] = [escapeMarkdownInline(clipText(input.summary, 420))];
  if (input.reason) {
    lines.push(`**说明**：${escapeMarkdownInline(clipText(input.reason, 220))}`);
  }

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: clipText(`[Paseo · ${categoryLabel}] ${input.title}`, 60) },
    },
    header: {
      title: plainText(`${categoryLabel} · ${clipText(input.title, 44)}`),
      subtitle: plainText("Paseo 对话管理 · 通知分级推送"),
      template,
      text_tag_list: [
        {
          tag: "text_tag",
          text: plainText(tierLabel),
          color: resolveNotificationTagColor(template),
        },
        ...(input.passthrough
          ? [
              {
                tag: "text_tag" as const,
                text: plainText("穿透低打扰"),
                color: "red" as const,
              },
            ]
          : []),
      ],
    },
    body: {
      elements: [
        markdownBlock(lines.join("\n")),
        noteBlock("此卡片为只读状态通知，如需深入操作请回到 Paseo 桌面或移动端。"),
      ],
    },
  };
}

export interface BuildResolvedCardInput {
  title: string;
  outcomeLabel: string;
  detailMessage: string;
  actorOpenId: string | null;
  resolvedAtIso: string;
  succeeded: boolean;
}

export function buildResolvedCard(input: BuildResolvedCardInput): FeishuCard2 {
  const lines = [
    `**处理结果**：${escapeMarkdownInline(clipText(input.outcomeLabel, 80))}`,
    `**详情**：${escapeMarkdownInline(clipText(input.detailMessage, 300))}`,
  ];
  if (input.actorOpenId) {
    lines.push(`**操作人**：\`${escapeMarkdownInline(input.actorOpenId)}\``);
  }
  lines.push(`**处理时间**：${input.resolvedAtIso}`);

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: clipText(`[Paseo · ${input.outcomeLabel}] ${input.title}`, 60) },
    },
    header: {
      title: plainText(`${input.outcomeLabel} · ${clipText(input.title, 44)}`),
      subtitle: plainText("Paseo 飞书机器人桥接 · 卡片已收敛至终态"),
      template: input.succeeded ? "green" : "grey",
      text_tag_list: [
        {
          tag: "text_tag",
          text: plainText(input.outcomeLabel),
          color: input.succeeded ? "green" : "neutral",
        },
      ],
    },
    body: {
      elements: [
        markdownBlock(lines.join("\n")),
        noteBlock("操作按钮已收起，重复点击将被幂等去重拦截。"),
      ],
    },
  };
}

export function buildTestConnectivityCard(input: {
  title?: string;
  sentAtIso: string;
  apiBaseUrl: string;
}): FeishuCard2 {
  const heading = input.title?.trim() || "Paseo 飞书机器人桥接连通性测试";
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: clipText(`[Paseo] ${heading}`, 60) },
    },
    header: {
      title: plainText(clipText(heading, 60)),
      subtitle: plainText("插件化隔离桥接 · feishu-bot-bridge"),
      template: "green",
      text_tag_list: [
        {
          tag: "text_tag",
          text: plainText("连通正常"),
          color: "green",
        },
      ],
    },
    body: {
      elements: [
        markdownBlock(
          [
            "收到本卡片即表示 **Paseo 飞书机器人桥接插件** 出站鉴权与发卡链路已跑通。",
            `**API 域名**：\`${escapeMarkdownInline(input.apiBaseUrl)}\``,
            `**发送时间**：${input.sentAtIso}`,
          ].join("\n"),
        ),
        noteBlock(
          "提示：如需审批卡片回写，请同步在飞书开放平台配置事件回调地址与允许操作人 Open ID 白名单。",
        ),
      ],
    },
  };
}
