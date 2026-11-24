import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  MAIN_CHAT_TASK_MODE_LABEL,
  MAIN_CHAT_TASK_PLAN_ID_LABEL,
  parseTaskAskUserToolPayload,
  parseTaskPlanToolOutput,
  parseTaskReworkToolPayload,
} from "@getpaseo/protocol/main-chat";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentLaunchContext, AgentSessionConfig } from "../agent/agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

interface RuntimeMcpConfig {
  url: string;
  headers?: Record<string, string>;
}

async function callDaemonMcpTool(
  runtimeMcp: RuntimeMcpConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(runtimeMcp.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...runtimeMcp.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  expect(response.status).toBe(200);
  const bodyText = await response.text();
  const dataLine = bodyText
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice("data:".length)
    .trim();
  const parsed = JSON.parse(dataLine ?? bodyText) as { result?: unknown; error?: unknown };
  expect(parsed.error).toBeUndefined();
  return parsed.result;
}

describe("main-chat real daemon E2E", () => {
  let ctx: DaemonTestContext;
  let repoDir: string;
  let capturedLaunches: Array<{ config: AgentSessionConfig; context?: AgentLaunchContext }>;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(os.tmpdir(), "paseo-main-chat-e2e-repo-"));
    await mkdir(repoDir, { recursive: true });
    capturedLaunches = [];

    const baseClients = createTestAgentClients();
    const baseCodex = baseClients.codex!;
    const originalCreateSession = baseCodex.createSession.bind(baseCodex);
    Object.defineProperty(baseCodex, "capabilities", {
      value: {
        ...baseCodex.capabilities,
        supportsMcpServers: true,
      },
      configurable: true,
    });
    baseCodex.createSession = async (config, context, options) => {
      capturedLaunches.push({ config, context });
      return originalCreateSession(config, context, options);
    };

    ctx = await createDaemonTestContext({
      mcpEnabled: true,
      agentClients: baseClients,
    });
    const initialSettings = await ctx.client.getMainChatSettings();
    expect(initialSettings.settings?.enabled).toBe(false);
    await ctx.client.updateMainChatSettings({ enabled: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(repoDir, { recursive: true, force: true });
  }, 60_000);

  it("ensures Main Chat idempotently and injects system prompt + MCP runtime", async () => {
    const serverInfo = ctx.client.getLastServerInfoMessage();
    expect(serverInfo?.features?.mainChat).toBe(true);

    const first = await ctx.client.ensureMainChat({ provider: "codex" });
    expect(first.error).toBeNull();
    expect(first.created).toBe(true);
    expect(first.agentId).toBeTruthy();
    expect(first.workspaceId).toBeTruthy();

    const second = await ctx.client.ensureMainChat({ provider: "codex" });
    expect(second.error).toBeNull();
    expect(second.created).toBe(false);
    expect(second.agentId).toBe(first.agentId);
    expect(second.workspaceId).toBe(first.workspaceId);

    const fetchedMain = await ctx.client.fetchAgent(first.agentId!);
    expect(fetchedMain?.agent.labels?.[MAIN_CHAT_ROLE_LABEL]).toBe(MAIN_CHAT_ROLE_VALUE);

    const mainLaunch = capturedLaunches.find((entry) => entry.context?.agentId === first.agentId);
    expect(
      mainLaunch?.config.pluginAppendSystemPrompt?.some((text) => text.includes("task_plan")),
    ).toBe(true);
  }, 60_000);

  it("dispatches readonly plans automatically and starts write plans via WebSocket RPC", async () => {
    const ensured = await ctx.client.ensureMainChat({ provider: "codex" });
    const mainAgentId = ensured.agentId!;
    const mainLaunch = capturedLaunches.find((entry) => entry.context?.agentId === mainAgentId);
    const runtimeMcp = mainLaunch?.config.mcpServers?.paseo as RuntimeMcpConfig | undefined;
    expect(runtimeMcp?.url).toBeTruthy();

    const readonlyResult = await callDaemonMcpTool(runtimeMcp!, "task_plan", {
      summary: "只读调研",
      tasks: [
        {
          title: "查仓库结构",
          goal: "列出目录",
          mode: "readonly",
          cwd: repoDir,
          doneWhen: ["输出目录清单"],
        },
      ],
    });
    const readonlyPlan = parseTaskPlanToolOutput(readonlyResult);
    expect(readonlyPlan?.status).toBe("started");
    expect(readonlyPlan?.autoStarted).toBe(true);

    const fetchedReadonlyChild = await ctx.client.fetchAgent(readonlyPlan!.tasks[0]!.agentId!);
    expect(fetchedReadonlyChild?.agent.labels?.[PARENT_AGENT_ID_LABEL]).toBe(mainAgentId);
    expect(fetchedReadonlyChild?.agent.labels?.[MAIN_CHAT_TASK_PLAN_ID_LABEL]).toBe(
      readonlyPlan!.id,
    );
    expect(fetchedReadonlyChild?.agent.labels?.[MAIN_CHAT_TASK_MODE_LABEL]).toBe("readonly");

    const writeResult = await callDaemonMcpTool(runtimeMcp!, "task_plan", {
      summary: "修复问题",
      tasks: [
        {
          title: "修复侧栏",
          goal: "修正样式偏移",
          mode: "write",
          cwd: repoDir,
          doneWhen: ["typecheck 通过"],
        },
      ],
    });
    const writePlan = parseTaskPlanToolOutput(writeResult);
    expect(writePlan?.status).toBe("open");

    const listed = await ctx.client.listMainChatPlans(mainAgentId);
    expect(listed.error).toBeNull();
    expect(listed.plans.map((p) => p.id)).toContain(writePlan!.id);

    const started = await ctx.client.startMainChatPlan(writePlan!.id);
    expect(started.error).toBeNull();
    expect(started.plan?.status).toBe("started");

    const fetchedWriteChild = await ctx.client.fetchAgent(started.plan!.tasks[0]!.agentId!);
    expect(fetchedWriteChild?.agent.labels?.[PARENT_AGENT_ID_LABEL]).toBe(mainAgentId);
    expect(fetchedWriteChild?.agent.labels?.[MAIN_CHAT_TASK_MODE_LABEL]).toBe("write");
  }, 60_000);

  it("supports rework, ask-user decisions, overview metrics, and rule management end-to-end", async () => {
    const ensured = await ctx.client.ensureMainChat({ provider: "codex" });
    const mainAgentId = ensured.agentId!;
    const mainLaunch = capturedLaunches.find((entry) => entry.context?.agentId === mainAgentId);
    const runtimeMcp = mainLaunch?.config.mcpServers?.paseo as RuntimeMcpConfig;

    const planResult = await callDaemonMcpTool(runtimeMcp, "task_plan", {
      summary: "端到端治理测试",
      tasks: [
        {
          title: "查结构",
          goal: "检查目录",
          mode: "readonly",
          cwd: repoDir,
          doneWhen: ["完成检查"],
        },
      ],
    });
    const plan = parseTaskPlanToolOutput(planResult);
    const childId = plan!.tasks[0]!.agentId!;

    const reworkResult = await callDaemonMcpTool(runtimeMcp, "task_rework", {
      agentId: childId,
      gaps: ["补跑 typecheck 并附上输出"],
    });
    expect(parseTaskReworkToolPayload(null, reworkResult)?.round).toBe(1);

    const askResult = await callDaemonMcpTool(runtimeMcp, "task_ask_user", {
      title: "发布方式",
      question: "先发 beta 还是直接发 stable？",
      agentId: childId,
      options: [
        { id: "beta", label: "先发 beta", leadsTo: "灰度验证" },
        { id: "stable", label: "直接 stable", leadsTo: "立即推送" },
      ],
      recommendedOptionId: "beta",
    });
    const decision = parseTaskAskUserToolPayload(askResult);
    expect(decision?.id).toBeTruthy();

    const answered = await ctx.client.answerMainChatDecision({
      decisionId: decision!.id,
      optionId: "beta",
      answer: "先发 beta",
    });
    expect(answered.error).toBeNull();
    expect(answered.decision?.answeredOptionId).toBe("beta");

    const addedRule = await ctx.client.addMainChatPermissionRule({
      toolName: "Bash",
      commandPrefix: "npm test",
      cwd: repoDir,
    });
    expect(addedRule.error).toBeNull();

    const overview = await ctx.client.getMainChatOverview(mainAgentId);
    expect(overview.error).toBeNull();
    expect(overview.overview?.decisions).toHaveLength(1);
    expect(overview.overview?.permissionRules).toHaveLength(1);
    expect(overview.overview?.metrics.reworkCount).toBe(1);

    const removed = await ctx.client.removeMainChatRule("permission", addedRule.rule!.id);
    expect(removed.error).toBeNull();
    expect(removed.removed).toBe(true);
  }, 60_000);

  it("executes compact, /clear, new_session handoff, and list_activity over real WebSocket RPC without losing child agents", async () => {
    const ensured = await ctx.client.ensureMainChat({ provider: "codex" });
    const mainAgentId = ensured.agentId!;
    const mainLaunch = capturedLaunches.find((entry) => entry.context?.agentId === mainAgentId);
    const runtimeMcp = mainLaunch?.config.mcpServers?.paseo as RuntimeMcpConfig;

    const planResult = await callDaemonMcpTool(runtimeMcp, "task_plan", {
      summary: "跨清空存活测试",
      tasks: [
        {
          title: "查结构",
          goal: "检查源码目录",
          mode: "readonly",
          cwd: repoDir,
          doneWhen: ["输出目录列表"],
        },
      ],
    });
    const plan = parseTaskPlanToolOutput(planResult);
    const childId = plan!.tasks[0]!.agentId!;

    const compacted = await ctx.client.compactMainChat({
      mainAgentId,
      reason: "manual",
      instructions: "保留目录检查任务",
    });
    expect(compacted.error).toBeNull();
    expect(compacted.compaction?.status).toBe("succeeded");

    const cleared = await ctx.client.clearMainChat({ mainAgentId });
    expect(cleared.error).toBeNull();
    expect(cleared.previousAgentId).toBe(mainAgentId);
    expect(cleared.agentId).toBeTruthy();
    expect(cleared.agentId).not.toBe(mainAgentId);
    expect(cleared.migratedPlans).toBe(1);
    expect(cleared.migratedChildAgents).toBe(1);

    // Child agent MUST still be unarchived and reparented to the new main chat!
    const fetchedChildAfterClear = await ctx.client.fetchAgent(childId);
    expect(fetchedChildAfterClear?.agent.archivedAt ?? null).toBeNull();
    expect(fetchedChildAfterClear?.agent.labels?.[PARENT_AGENT_ID_LABEL]).toBe(cleared.agentId);

    const handedOff = await ctx.client.startNewMainChatSession({
      mainAgentId: cleared.agentId!,
      carryHandoffSummary: true,
      title: "交接后总控",
    });
    expect(handedOff.error).toBeNull();
    expect(handedOff.previousAgentId).toBe(cleared.agentId);
    expect(handedOff.agentId).toBeTruthy();
    expect(handedOff.handoffSummary).toContain("查结构");
    expect(handedOff.migratedChildAgents).toBe(1);

    const fetchedChildAfterHandoff = await ctx.client.fetchAgent(childId);
    expect(fetchedChildAfterHandoff?.agent.archivedAt ?? null).toBeNull();
    expect(fetchedChildAfterHandoff?.agent.labels?.[PARENT_AGENT_ID_LABEL]).toBe(handedOff.agentId);

    const activities = await ctx.client.listMainChatActivity({
      mainAgentId: handedOff.agentId!,
      limit: 20,
    });
    expect(activities.error).toBeNull();
    expect(activities.activities.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["compaction", "clear", "handoff"]),
    );

    const overview = await ctx.client.getMainChatOverview(handedOff.agentId!);
    expect(overview.error).toBeNull();
    expect(overview.overview?.plans.map((p) => p.id)).toContain(plan!.id);
    expect(overview.overview?.recentActivityCount).toBeGreaterThanOrEqual(3);
  }, 60_000);
});
