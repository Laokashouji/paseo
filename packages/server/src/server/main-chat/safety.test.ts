import { describe, expect, it } from "vitest";
import type {
  MainChatDecisionRecord,
  MainChatPlanRecord,
  MainChatRuleSuggestion,
  MainChatSessionTriage,
  MainChatStandingAuthorization,
  MainChatTaskReceipt,
  MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import {
  DUPLICATE_QUESTION_WINDOW_MS,
  PERMISSION_HARD_DEADLINE_MS,
  SUPERVISOR_BUSY_MAX_HOLD_MS,
  SUPERVISOR_IDLE_ESCALATE_MS,
  buildDeterministicClarificationAnswer,
  buildNextStepSuggestions,
  checkDuplicateQuestionGuard,
  checkRedLineGuard,
  createApprovalClarificationRecord,
  createApprovalInterceptionTracker,
  createClarificationProofStore,
  matchStandingAuthorization,
  recordManualApprovalObservation,
} from "./safety.js";

function makeStandingAuth(
  overrides: Partial<MainChatStandingAuthorization> = {},
): MainChatStandingAuthorization {
  return {
    id: overrides.id ?? "auth_1",
    scope: overrides.scope ?? "permission",
    serverId: overrides.serverId ?? null,
    cwd: overrides.cwd ?? "/repo",
    allowSubdirectories: overrides.allowSubdirectories,
    toolName: overrides.toolName ?? "Bash",
    commandPrefix: overrides.commandPrefix ?? "npm test",
    mode: overrides.mode ?? null,
    label: overrides.label ?? "自动放行 Bash (npm test)",
    reason: overrides.reason ?? null,
    createdAt: overrides.createdAt ?? "2026-11-23T08:00:00.000Z",
    lastMatchedAt: overrides.lastMatchedAt ?? null,
    matchCount: overrides.matchCount ?? 0,
    expiresAt: overrides.expiresAt ?? null,
    revokedAt: overrides.revokedAt ?? null,
  };
}

describe("main-chat safety (M5)", () => {
  it("enforces 5m supervisor idle escalation, 1h busy pause, and non-resettable 15m permission hard deadline", () => {
    const t0 = Date.parse("2026-11-23T10:00:00.000Z");
    const tracker = createApprovalInterceptionTracker({ now: () => t0 });

    const tracked = tracker.track({
      agentId: "child_1",
      serverId: "srv_local",
      requestId: "perm_1",
      taskId: "task_1",
      conversationId: "conv_leader_1",
      category: "permission",
      label: "Bash: npm test",
      initialTier: "leader",
      nowMs: t0,
    });
    const originalDeadline = tracked.hardDeadlineAtMs;
    expect(originalDeadline).toBe(t0 + PERMISSION_HARD_DEADLINE_MS);

    // At 4m idle -> still with leader
    expect(tracker.evaluateTick(t0 + 4 * 60_000, () => false)).toHaveLength(0);

    // At 5m idle -> escalates leader -> main, WITHOUT resetting hardDeadlineAtMs!
    const esc1 = tracker.evaluateTick(t0 + SUPERVISOR_IDLE_ESCALATE_MS, () => false);
    expect(esc1).toHaveLength(1);
    expect(esc1[0]?.fromTier).toBe("leader");
    expect(esc1[0]?.toTier).toBe("main");
    expect(esc1[0]?.reason).toBe("supervisor_idle");
    expect(esc1[0]?.entry.hardDeadlineAtMs).toBe(originalDeadline);

    // Main is busy running a long turn from minute 5 to minute 14 -> idle clock paused!
    expect(tracker.evaluateTick(t0 + 11 * 60_000, () => true)).toHaveLength(0);
    expect(tracker.evaluateTick(t0 + 14 * 60_000, () => true)).toHaveLength(0);
    expect(tracker.get("child_1", "perm_1")?.tier).toBe("main");

    // At minute 15 -> non-resettable hard deadline fires even while main is STILL busy!
    const esc2 = tracker.evaluateTick(t0 + PERMISSION_HARD_DEADLINE_MS, () => true);
    expect(esc2).toHaveLength(1);
    expect(esc2[0]?.fromTier).toBe("main");
    expect(esc2[0]?.toTier).toBe("user");
    expect(esc2[0]?.reason).toBe("hard_deadline");
    expect(esc2[0]?.entry.hardDeadlineAtMs).toBe(originalDeadline);

    // Question (no 15m permission hard deadline) respects 1h busy hold limit
    tracker.track({
      agentId: "child_2",
      requestId: "q_1",
      category: "question",
      label: "接口字段命名确认",
      initialTier: "main",
      nowMs: t0,
    });
    expect(tracker.evaluateTick(t0 + 30 * 60_000, () => true)).toHaveLength(0);
    const escBusy = tracker.evaluateTick(t0 + SUPERVISOR_BUSY_MAX_HOLD_MS, () => true);
    expect(escBusy).toHaveLength(1);
    expect(escBusy[0]?.toTier).toBe("user");
    expect(escBusy[0]?.reason).toBe("supervisor_busy_timeout");
  });

  it("blocks all hardcoded red-line categories and allows benign dev operations", () => {
    const externalMsg = checkRedLineGuard({
      toolName: "lark_im_send",
      question: "要不要发飞书群消息通知大家上线？",
    });
    expect(externalMsg.blocked).toBe(true);
    expect(externalMsg.category).toBe("external_message");
    expect(externalMsg.reason).toContain("红线");

    const dropDb = checkRedLineGuard({
      toolName: "Bash",
      command: "psql -c 'DROP TABLE users;'",
    });
    expect(dropDb.blocked).toBe(true);
    expect(dropDb.category).toBe("destructive_delete");

    const rmRf = checkRedLineGuard({
      toolName: "Bash",
      command: "rm -rf /tmp/build-cache",
    });
    expect(rmRf.blocked).toBe(true);
    expect(rmRf.category).toBe("destructive_delete");

    const gitPush = checkRedLineGuard({
      toolName: "Bash",
      command: "git push --force origin main",
    });
    expect(gitPush.blocked).toBe(true);
    expect(gitPush.category).toBe("git_remote_or_merge");

    const prodDeploy = checkRedLineGuard({
      question: "现在直接生产发布并修改凭据密钥吗？",
    });
    expect(prodDeploy.blocked).toBe(true);
    expect(prodDeploy.category).toBe("production_deploy_or_secret");

    const permConfig = checkRedLineGuard({
      toolName: "Bash",
      command: "sudo chmod 777 /etc/sudoers",
    });
    expect(permConfig.blocked).toBe(true);
    expect(permConfig.category).toBe("permission_or_system_config");

    const chained = checkRedLineGuard({
      toolName: "Bash",
      command: "npm test && echo done",
    });
    expect(chained.blocked).toBe(true);
    expect(chained.category).toBe("chained_shell_command");

    const safeTest = checkRedLineGuard({
      toolName: "Bash",
      command: "npm test -- --run",
      question: "是否重跑本地单测？",
      answer: "暂不推送，先跑单测",
    });
    expect(safeTest.blocked).toBe(false);
    expect(safeTest.reason).toBeNull();
  });

  it("blocks duplicate questions within 24 hours and allows after 24h expiry", () => {
    const nowMs = Date.parse("2026-11-23T12:00:00.000Z");
    const oneHourAgo = new Date(nowMs - 60 * 60_000).toISOString();
    const twentyFiveHoursAgo = new Date(
      nowMs - DUPLICATE_QUESTION_WINDOW_MS - 60 * 60_000,
    ).toISOString();

    const hit = checkDuplicateQuestionGuard({
      question: "请问默认超时选 30s 还是 60s？",
      recentQuestions: [{ text: "默认超时选 30s 还是 60s", at: oneHourAgo }],
      nowMs,
    });
    expect(hit.isDuplicate).toBe(true);
    expect(hit.similarity).toBeGreaterThanOrEqual(0.8);

    const expired = checkDuplicateQuestionGuard({
      question: "请问默认超时选 30s 还是 60s？",
      recentQuestions: [{ text: "默认超时选 30s 还是 60s", at: twentyFiveHoursAgo }],
      nowMs,
    });
    expect(expired.isDuplicate).toBe(false);

    const distinct = checkDuplicateQuestionGuard({
      question: "单测是否需要覆盖空数组输入？",
      recentQuestions: [{ text: "默认超时选 30s 还是 60s", at: oneHourAgo }],
      nowMs,
    });
    expect(distinct.isDuplicate).toBe(false);
  });

  it("pauses approval deadline on clarification and enforces one-time anti-replay proofToken", () => {
    const t0 = Date.parse("2026-11-23T10:00:00.000Z");
    const tracker = createApprovalInterceptionTracker({ now: () => t0 });
    tracker.track({
      agentId: "child_1",
      requestId: "perm_clarify",
      category: "permission",
      label: "Bash: npm test",
      initialTier: "main",
      nowMs: t0,
    });

    const paused = tracker.pauseForClarification({
      agentId: "child_1",
      requestId: "perm_clarify",
      nowMs: t0 + 2 * 60_000,
    });
    expect(paused.entry.pausedForClarification).toBe(true);
    expect(paused.pausedDeadlineAt).toBe(new Date(t0 + PERMISSION_HARD_DEADLINE_MS).toISOString());

    // While paused for clarification, even 20m passing does NOT auto-escalate behind user's back
    expect(tracker.evaluateTick(t0 + 20 * 60_000, () => false)).toHaveLength(0);

    const proofStore = createClarificationProofStore();
    const token = proofStore.issue({
      agentId: "child_1",
      permissionRequestId: "perm_clarify",
      nowIso: new Date(t0).toISOString(),
    });
    expect(proofStore.hasActive(token)).toBe(true);
    // Wrong binding rejected without consuming
    expect(proofStore.consume(token, { agentId: "other_agent" })).toBe(false);
    expect(proofStore.hasActive(token)).toBe(true);
    // First valid consume succeeds
    expect(
      proofStore.consume(token, { agentId: "child_1", permissionRequestId: "perm_clarify" }),
    ).toBe(true);
    // Replay fails!
    expect(
      proofStore.consume(token, { agentId: "child_1", permissionRequestId: "perm_clarify" }),
    ).toBe(false);

    const answer = buildDeterministicClarificationAnswer({
      question: "这个命令会改代码吗？",
      toolName: "Bash",
      command: "npm test -- --run",
      redLine: checkRedLineGuard({ toolName: "Bash", command: "npm test -- --run" }),
    });
    const record = createApprovalClarificationRecord({
      agentId: "child_1",
      serverId: "srv_local",
      permissionRequestId: "perm_clarify",
      question: "这个命令会改代码吗？",
      answer,
      proofToken: token,
      pausedDeadlineAt: paused.pausedDeadlineAt,
      nowIso: new Date(t0).toISOString(),
    });
    expect(record.answer).toContain("npm test");
    expect(record.answeredAt).toBeTruthy();
  });

  it("deterministically matches standing authorizations, respects directory boundaries, revocation, expiry, and red-line veto", () => {
    const nowMs = Date.parse("2026-11-23T12:00:00.000Z");
    const activeAuth = makeStandingAuth({
      id: "auth_ok",
      scope: "permission",
      serverId: "srv_a",
      cwd: "/repo",
      allowSubdirectories: true,
      toolName: "Bash",
      commandPrefix: "npm test",
      expiresAt: "2026-11-24T00:00:00.000Z",
    });
    const revokedAuth = makeStandingAuth({
      id: "auth_revoked",
      cwd: "/repo",
      toolName: "Read",
      commandPrefix: null,
      revokedAt: "2026-11-23T11:00:00.000Z",
    });
    const expiredAuth = makeStandingAuth({
      id: "auth_expired",
      cwd: "/repo",
      toolName: "Glob",
      commandPrefix: null,
      expiresAt: "2026-11-23T11:59:00.000Z",
    });
    const overlyBroadRedLineAuth = makeStandingAuth({
      id: "auth_broad",
      cwd: "/repo",
      toolName: "Bash",
      commandPrefix: "git push",
    });

    const auths = [activeAuth, revokedAuth, expiredAuth, overlyBroadRedLineAuth];

    // Valid subdir match
    const hit = matchStandingAuthorization(
      {
        scope: "permission",
        serverId: "srv_a",
        localServerId: "srv_a",
        cwd: "/repo/packages/server",
        toolName: "Bash",
        command: "npm test -- --run",
      },
      auths,
      nowMs,
    );
    expect(hit.matched).toBe(true);
    expect(hit.authorization?.id).toBe("auth_ok");

    // Prefix confusion `/repo-other` MUST NOT match `/repo`!
    const siblingDir = matchStandingAuthorization(
      {
        scope: "permission",
        serverId: "srv_a",
        localServerId: "srv_a",
        cwd: "/repo-other",
        toolName: "Bash",
        command: "npm test",
      },
      auths,
      nowMs,
    );
    expect(siblingDir.matched).toBe(false);

    // Wrong serverId MUST NOT match
    const wrongHost = matchStandingAuthorization(
      {
        scope: "permission",
        serverId: "srv_b",
        localServerId: "srv_a",
        cwd: "/repo",
        toolName: "Bash",
        command: "npm test",
      },
      auths,
      nowMs,
    );
    expect(wrongHost.matched).toBe(false);

    // Revoked & expired immediately fail
    expect(
      matchStandingAuthorization(
        { scope: "permission", cwd: "/repo", toolName: "Read" },
        auths,
        nowMs,
      ).matched,
    ).toBe(false);
    expect(
      matchStandingAuthorization(
        { scope: "permission", cwd: "/repo", toolName: "Glob" },
        auths,
        nowMs,
      ).matched,
    ).toBe(false);

    // Red-line command vetoed BEFORE rule match even though auth_broad exists!
    const redLineHit = matchStandingAuthorization(
      {
        scope: "permission",
        cwd: "/repo",
        toolName: "Bash",
        command: "git push origin main",
      },
      auths,
      nowMs,
    );
    expect(redLineHit.matched).toBe(false);
    expect(redLineHit.blockedByRedLine?.blocked).toBe(true);
  });

  it("emits progressive rule suggestions on 2nd manual safe approval and never re-prompts after dismiss", () => {
    const nowIso = "2026-11-23T12:00:00.000Z";
    const first = recordManualApprovalObservation({
      scope: "permission",
      cwd: "/repo",
      toolName: "Bash",
      command: "npm test -- --run",
      existingObservation: null,
      existingAuthorizations: [],
      existingSuggestions: [],
      nowIso,
    });
    expect(first.eligible).toBe(true);
    expect(first.observation?.count).toBe(1);
    expect(first.suggestion).toBeNull();

    const second = recordManualApprovalObservation({
      scope: "permission",
      cwd: "/repo",
      toolName: "Bash",
      command: "npm test -- src/a.test.ts",
      existingObservation: first.observation,
      existingAuthorizations: [],
      existingSuggestions: [],
      nowIso,
    });
    expect(second.eligible).toBe(true);
    expect(second.observation?.count).toBe(2);
    expect(second.suggestion).not.toBeNull();
    expect(second.suggestion?.observedCount).toBe(2);
    expect(second.suggestion?.commandPrefix).toBe("npm test");

    // Dismissed suggestion never re-appears on 3rd approval
    const dismissedList: MainChatRuleSuggestion[] = [
      { ...second.suggestion!, dismissedAt: "2026-11-23T12:05:00.000Z" },
    ];
    const third = recordManualApprovalObservation({
      scope: "permission",
      cwd: "/repo",
      toolName: "Bash",
      command: "npm test",
      existingObservation: second.observation,
      existingAuthorizations: [],
      existingSuggestions: dismissedList,
      nowIso,
    });
    expect(third.eligible).toBe(false);
    expect(third.suggestion).toBeNull();

    // Red-line command never produces a suggestion
    const redLineObs = recordManualApprovalObservation({
      scope: "permission",
      cwd: "/repo",
      toolName: "Bash",
      command: "git push origin main",
      existingObservation: null,
      existingAuthorizations: [],
      existingSuggestions: [],
      threshold: 1,
      nowIso,
    });
    expect(redLineObs.eligible).toBe(false);
    expect(redLineObs.suggestion).toBeNull();
  });

  it("builds up to 4 nextStepSuggestions and distinguishes safe vs risky prompts", () => {
    const nowIso = "2026-11-23T12:00:00.000Z";
    const tasks: MainChatTaskRecord[] = [
      {
        id: "t_review",
        mainAgentId: "main_1",
        planId: "p_0",
        title: "补齐安全单测",
        mode: "write",
        isolation: "worktree",
        cwd: "/repo",
        workspaceId: "ws_1",
        workspaceLabel: "repo",
        status: "awaiting_review",
        brief: {
          goal: "补齐单测",
          doneWhen: ["通过"],
          outOfBounds: [],
          scopeRevision: 1,
          updatedAt: nowIso,
        },
        agentIds: ["a_1"],
        activeAgentId: "a_1",
        lastActivityAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: "t_parked",
        mainAgentId: "main_1",
        planId: "p_0",
        title: "依赖接口升级",
        mode: "write",
        isolation: "worktree",
        cwd: "/repo",
        workspaceId: "ws_1",
        workspaceLabel: "repo",
        status: "parked",
        parkedReason: "等上游发版",
        brief: {
          goal: "升级接口",
          doneWhen: ["通过"],
          outOfBounds: [],
          scopeRevision: 1,
          updatedAt: nowIso,
        },
        agentIds: ["a_2"],
        activeAgentId: "a_2",
        lastActivityAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ];
    const plans: MainChatPlanRecord[] = [
      {
        id: "p_open_write",
        mainAgentId: "main_1",
        status: "open",
        autoStarted: false,
        summary: "重构审批防线",
        createdAt: nowIso,
        startedAt: null,
        cancelledAt: null,
        tasks: [
          {
            id: "pt_1",
            title: "实现安全校验",
            goal: "落地红线守卫",
            mode: "write",
            isolation: "worktree",
            cwd: "/repo",
            workspaceId: "ws_1",
            workspaceLabel: "repo",
            reason: "需要修改代码",
            doneWhen: ["单测通过"],
            outOfBounds: [],
            agentId: null,
            startedAt: null,
            startError: null,
          },
        ],
      },
    ];
    const triages: MainChatSessionTriage[] = [
      {
        agentId: "a_stalled",
        workspaceId: "ws_1",
        title: "排查日志脚本",
        managedByMainChat: true,
        phase: "stalled",
        summary: "已静默运行 25 分钟",
        waitReason: "无输出",
        suggestedAction: "查看状态",
        triageSource: "rule",
        updatedAt: nowIso,
      },
    ];
    const decisions: MainChatDecisionRecord[] = [];
    const receipts: MainChatTaskReceipt[] = [
      {
        title: "修复导出",
        summary: "已完成",
        agentId: "a_done",
        planId: "p_old",
        taskId: "t_done",
        checks: [],
        nextSteps: ["合并 PR 并推送到 main"],
      },
    ];

    const suggestions = buildNextStepSuggestions({
      tasks,
      plans,
      decisions,
      triages,
      recentReceipts: receipts,
    });
    expect(suggestions).toHaveLength(4);
    expect(suggestions[0]?.id).toBe("nxt_review_t_review");
    expect(suggestions[0]?.risky).toBe(false);
    expect(suggestions[1]?.id).toBe("nxt_plan_p_open_write");
    expect(suggestions[1]?.risky).toBe(true);
    expect(suggestions[2]?.id).toBe("nxt_triage_a_stalled");
    expect(suggestions[2]?.risky).toBe(false);
    expect(suggestions[3]?.id).toBe("nxt_parked_t_parked");
    expect(suggestions[3]?.risky).toBe(false);

    // Receipt with merge/push next step gets marked risky: true
    const receiptOnly = buildNextStepSuggestions({
      tasks: [],
      plans: [],
      decisions: [],
      triages: [],
      recentReceipts: receipts,
    });
    expect(receiptOnly).toHaveLength(1);
    expect(receiptOnly[0]?.risky).toBe(true);
  });
});
