import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  buildMissingReplyRecoveryPrompt,
  generateStructuredAgentResponse,
  getStructuredAgentResponse,
  generateStructuredAgentResponseWithFallback,
  isExplicitSilentSentinel,
  isPlaceholderEmptyReply,
  isSilentBackgroundReply,
  isStructuredGenerationAuthFailure,
  shouldRecoverMissingFinalReply,
  StructuredAgentFallbackError,
  StructuredAgentResponseError,
  type AgentCaller,
} from "./agent-response-loop.js";
import type { AgentManager } from "./agent-manager.js";

function createScriptedCaller(responses: string[]) {
  const prompts: string[] = [];
  const caller: AgentCaller = async (prompt) => {
    prompts.push(prompt);
    const index = prompts.length - 1;
    return responses[index] ?? responses[responses.length - 1] ?? "";
  };
  return { caller, prompts };
}

describe("getStructuredAgentResponse", () => {
  it("retries on invalid JSON and succeeds", async () => {
    const schema = z.object({ title: z.string() });
    const { caller, prompts } = createScriptedCaller(["not json", '{"title":"ok"}']);

    const result = await getStructuredAgentResponse({
      caller,
      prompt: "Provide a title",
      schema,
      maxRetries: 2,
    });

    expect(result).toEqual({ title: "ok" });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Previous response was invalid");
    expect(prompts[1]).toContain("Invalid JSON");
  });

  it("retries on schema mismatch with validation errors", async () => {
    const schema = z.object({ count: z.number() });
    const { caller, prompts } = createScriptedCaller(['{"count":"nope"}', '{"count":2}']);

    const result = await getStructuredAgentResponse({
      caller,
      prompt: "Provide a count",
      schema,
      maxRetries: 2,
    });

    expect(result).toEqual({ count: 2 });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("validation errors");
    expect(prompts[1]).toContain("count");
  });

  it("fails after maxRetries with last response and validation errors", async () => {
    const schema = z.object({ count: z.number() });
    const { caller } = createScriptedCaller(['{"count":"nope"}', '{"count":"still"}']);

    try {
      await getStructuredAgentResponse({
        caller,
        prompt: "Provide a count",
        schema,
        maxRetries: 1,
      });
      throw new Error("Expected getStructuredAgentResponse to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredAgentResponseError);
      expect(error).toEqual(
        expect.objectContaining({
          name: "StructuredAgentResponseError",
          lastResponse: '{"count":"still"}',
          validationErrors: expect.arrayContaining([expect.stringContaining("count")]),
        }),
      );
    }
  });

  it("retries on raw JSON Schema validation errors and succeeds", async () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    };
    const { caller, prompts } = createScriptedCaller(['{"name": 123}', '{"name": "ok"}']);

    const result = await getStructuredAgentResponse({
      caller,
      prompt: "Provide a name",
      schema,
      maxRetries: 2,
    });

    expect(result).toEqual({ name: "ok" });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("validation errors");
  });

  it("extracts JSON from markdown code fences", async () => {
    const schema = z.object({ message: z.string() });
    const { caller } = createScriptedCaller(['```json\n{"message": "hello"}\n```']);

    const result = await getStructuredAgentResponse({
      caller,
      prompt: "Provide a message",
      schema,
      maxRetries: 0,
    });

    expect(result).toEqual({ message: "hello" });
  });

  it("extracts JSON from plain code fences", async () => {
    const schema = z.object({ value: z.number() });
    const { caller } = createScriptedCaller(['```\n{"value": 42}\n```']);

    const result = await getStructuredAgentResponse({
      caller,
      prompt: "Provide a value",
      schema,
      maxRetries: 0,
    });

    expect(result).toEqual({ value: 42 });
  });
});

describe("generateStructuredAgentResponseWithFallback", () => {
  const schema = z.object({ summary: z.string() });

  function createManager(
    availability: Array<{ provider: string; available: boolean; error: string | null }>,
  ): AgentManager & { checkedProviders: string[] } {
    const checkedProviders: string[] = [];
    const availabilityByProvider = new Map(availability.map((entry) => [entry.provider, entry]));
    return {
      checkedProviders,
      getProviderAvailability: async (provider: string) => {
        checkedProviders.push(provider);
        return (
          availabilityByProvider.get(provider) ?? {
            provider,
            available: false,
            error: `No client registered for provider '${provider}'`,
          }
        );
      },
    } as unknown as AgentManager & { checkedProviders: string[] };
  }

  it("uses the first available provider in the waterfall", async () => {
    const calls: Array<{ provider: string; model?: string; persistSession?: boolean }> = [];
    const manager = createManager([
      { provider: "claude", available: true, error: null },
      { provider: "codex", available: true, error: null },
      { provider: "opencode", available: true, error: null },
    ]);

    const result = await generateStructuredAgentResponseWithFallback({
      manager,
      cwd: "/tmp/project",
      prompt: "Return JSON",
      schema,
      providers: [
        { provider: "claude", model: "haiku" },
        { provider: "codex", model: "gpt-5.4-mini" },
      ],
      persistSession: false,
      runner: async (options) => {
        calls.push({
          provider: options.agentConfig.provider,
          model: options.agentConfig.model ?? undefined,
          persistSession: options.persistSession,
        });
        return { summary: "ok" };
      },
    });

    expect(result).toEqual({ summary: "ok" });
    expect(calls).toEqual([{ provider: "claude", model: "haiku", persistSession: false }]);
    expect(manager.checkedProviders).toEqual(["claude"]);
  });

  it("skips unavailable providers and uses the next available one", async () => {
    const calls: Array<{ provider: string; model?: string }> = [];
    const manager = createManager([
      { provider: "claude", available: false, error: "missing auth" },
      { provider: "codex", available: true, error: null },
      { provider: "opencode", available: true, error: null },
    ]);

    const result = await generateStructuredAgentResponseWithFallback({
      manager,
      cwd: "/tmp/project",
      prompt: "Return JSON",
      schema,
      providers: [
        { provider: "claude", model: "haiku" },
        { provider: "codex", model: "gpt-5.4-mini" },
      ],
      runner: async (options) => {
        calls.push({
          provider: options.agentConfig.provider,
          model: options.agentConfig.model ?? undefined,
        });
        return { summary: "ok" };
      },
    });

    expect(result).toEqual({ summary: "ok" });
    expect(calls).toEqual([{ provider: "codex", model: "gpt-5.4-mini" }]);
    expect(manager.checkedProviders).toEqual(["claude", "codex"]);
  });

  it("falls back when an available provider fails", async () => {
    const calls: Array<{ provider: string; model?: string }> = [];
    const manager = createManager([
      { provider: "claude", available: true, error: null },
      { provider: "codex", available: true, error: null },
      { provider: "opencode", available: true, error: null },
    ]);

    const result = await generateStructuredAgentResponseWithFallback({
      manager,
      cwd: "/tmp/project",
      prompt: "Return JSON",
      schema,
      providers: [
        { provider: "claude", model: "haiku" },
        { provider: "codex", model: "gpt-5.4-mini" },
      ],
      runner: async (options) => {
        calls.push({
          provider: options.agentConfig.provider,
          model: options.agentConfig.model ?? undefined,
        });
        if (options.agentConfig.provider === "claude") {
          throw new Error("claude failed");
        }
        return { summary: "ok" };
      },
    });

    expect(result).toEqual({ summary: "ok" });
    expect(calls).toEqual([
      { provider: "claude", model: "haiku" },
      { provider: "codex", model: "gpt-5.4-mini" },
    ]);
    expect(manager.checkedProviders).toEqual(["claude", "codex"]);
  });

  it("logs the provider, model and error of every failed attempt", async () => {
    const warnings: Array<{ obj: object; msg?: string }> = [];
    const runnerError = new Error("connection refused");
    const manager = createManager([
      { provider: "local-llm", available: true, error: null },
      { provider: "opencode", available: false, error: "not installed" },
    ]);

    await expect(
      generateStructuredAgentResponseWithFallback({
        manager,
        cwd: "/tmp/project",
        prompt: "Return JSON",
        schema,
        schemaName: "BranchName",
        providers: [
          { provider: "local-llm", model: "qwen-local" },
          { provider: "opencode", model: "minimax-m3" },
        ],
        logger: {
          info: () => undefined,
          warn: (obj, msg) => warnings.push({ obj, msg }),
        },
        runner: async () => {
          throw runnerError;
        },
      }),
    ).rejects.toBeInstanceOf(StructuredAgentFallbackError);

    expect(warnings).toEqual([
      {
        obj: {
          err: runnerError,
          provider: "local-llm",
          model: "qwen-local",
          schemaName: "BranchName",
        },
        msg: "Structured generation: provider failed",
      },
      {
        obj: {
          provider: "opencode",
          model: "minimax-m3",
          schemaName: "BranchName",
          reason: "not installed",
        },
        msg: "Structured generation: skipping unavailable provider",
      },
    ]);
  });

  it("throws a fallback error when all providers are unavailable or fail", async () => {
    const manager = createManager([
      { provider: "claude", available: false, error: "missing auth" },
      { provider: "codex", available: true, error: null },
      { provider: "opencode", available: false, error: "not installed" },
    ]);

    await expect(
      generateStructuredAgentResponseWithFallback({
        manager,
        cwd: "/tmp/project",
        prompt: "Return JSON",
        schema,
        providers: [
          { provider: "claude", model: "haiku" },
          { provider: "codex", model: "gpt-5.4-mini" },
          { provider: "opencode", model: "opencode/gpt-5-nano" },
        ],
        runner: async () => {
          throw new Error("failed");
        },
      }),
    ).rejects.toBeInstanceOf(StructuredAgentFallbackError);
  });

  it("defaults ephemeral structured generation agents to internal=true unless explicitly overridden", async () => {
    const createdConfigs: Array<Record<string, unknown>> = [];
    const manager = {
      createAgent: async (config: Record<string, unknown>) => {
        createdConfigs.push(config);
        return { id: `ephemeral_${createdConfigs.length}` };
      },
      runAgent: async () => ({
        finalText: '{"summary":"ok"}',
        timeline: [],
      }),
      closeAgent: async () => undefined,
      deleteAgentState: async () => undefined,
    } as unknown as AgentManager;

    await generateStructuredAgentResponse({
      manager,
      agentConfig: { provider: "claude", cwd: "/tmp/project" },
      prompt: "Return JSON",
      schema,
    });
    await generateStructuredAgentResponse({
      manager,
      agentConfig: { provider: "claude", cwd: "/tmp/project", internal: false },
      prompt: "Return JSON",
      schema,
    });

    expect(createdConfigs[0]?.internal).toBe(true);
    expect(createdConfigs[1]?.internal).toBe(false);
  });

  it("cools down auth-failed providers across fallback models and subsequent calls until expiry", async () => {
    expect(
      isStructuredGenerationAuthFailure(
        "Failed to authenticate: OAuth session expired and could not be refreshed",
      ),
    ).toBe(true);
    expect(
      isStructuredGenerationAuthFailure(
        '{"name":"APIError","data":{"message":"API key expired.","statusCode":401}}',
      ),
    ).toBe(true);
    expect(isStructuredGenerationAuthFailure("connection reset by peer")).toBe(false);

    const manager = createManager([
      { provider: "opencode", available: true, error: null },
      { provider: "claude", available: true, error: null },
      { provider: "codex", available: true, error: null },
    ]);

    let currentNow = 1_000_000;
    const called: string[] = [];
    const providers = [
      { provider: "opencode", model: "openrouter/openai/gpt-5.4-mini" },
      { provider: "opencode", model: "openrouter/minimax/minimax-m3" },
      { provider: "claude", model: "claude-haiku-5-5" },
      { provider: "codex", model: "gpt-5.4-mini" },
    ];

    // First call: opencode fails with 401 -> second opencode model skipped immediately;
    // claude fails with OAuth expired; codex succeeds.
    const first = await generateStructuredAgentResponseWithFallback({
      manager,
      cwd: "/tmp/project",
      prompt: "Return JSON",
      schema,
      providers,
      authFailureCooldownMs: 60_000,
      now: () => currentNow,
      runner: async (opts) => {
        called.push(`${opts.agentConfig.provider}:${opts.agentConfig.model}`);
        if (opts.agentConfig.provider === "opencode") {
          throw new Error(
            '{"name":"APIError","data":{"message":"API key expired.","statusCode":401}}',
          );
        }
        if (opts.agentConfig.provider === "claude") {
          throw new Error("Failed to authenticate: OAuth session expired");
        }
        return { summary: "ok-1" };
      },
    });
    expect(first).toEqual({ summary: "ok-1" });
    expect(called).toEqual([
      "opencode:openrouter/openai/gpt-5.4-mini",
      "claude:claude-haiku-5-5",
      "codex:gpt-5.4-mini",
    ]);

    // Second call within cooldown: skips both opencode and claude immediately, goes straight to codex.
    called.length = 0;
    currentNow += 10_000;
    const second = await generateStructuredAgentResponseWithFallback({
      manager,
      cwd: "/tmp/project",
      prompt: "Return JSON",
      schema,
      providers,
      authFailureCooldownMs: 60_000,
      now: () => currentNow,
      runner: async (opts) => {
        called.push(`${opts.agentConfig.provider}:${opts.agentConfig.model}`);
        return { summary: "ok-2" };
      },
    });
    expect(second).toEqual({ summary: "ok-2" });
    expect(called).toEqual(["codex:gpt-5.4-mini"]);

    // Single-provider explicit call is not blocked by cooldown and clears cooldown on success.
    called.length = 0;
    const explicitSingle = await generateStructuredAgentResponseWithFallback({
      manager,
      cwd: "/tmp/project",
      prompt: "Return JSON",
      schema,
      providers: [{ provider: "claude", model: "claude-haiku-5-5" }],
      authFailureCooldownMs: 60_000,
      now: () => currentNow,
      runner: async (opts) => {
        called.push(`${opts.agentConfig.provider}:${opts.agentConfig.model}`);
        return { summary: "ok-explicit" };
      },
    });
    expect(explicitSingle).toEqual({ summary: "ok-explicit" });
    expect(called).toEqual(["claude:claude-haiku-5-5"]);

    // After cooldown expires, opencode is retried again.
    called.length = 0;
    currentNow += 60_000;
    const third = await generateStructuredAgentResponseWithFallback({
      manager,
      cwd: "/tmp/project",
      prompt: "Return JSON",
      schema,
      providers,
      authFailureCooldownMs: 60_000,
      now: () => currentNow,
      runner: async (opts) => {
        called.push(`${opts.agentConfig.provider}:${opts.agentConfig.model}`);
        return { summary: "ok-3" };
      },
    });
    expect(third).toEqual({ summary: "ok-3" });
    expect(called).toEqual(["opencode:openrouter/openai/gpt-5.4-mini"]);
  });
});

describe("silent sentinel and missing-reply recovery guards", () => {
  it("recognizes explicit silent sentinels and placeholder empty replies", () => {
    expect(isExplicitSilentSentinel("[SILENT]")).toBe(true);
    expect(isExplicitSilentSentinel("  `NO_ACTION`  ")).toBe(true);
    expect(isExplicitSilentSentinel("<silent/>")).toBe(true);
    expect(isExplicitSilentSentinel("当前一切正常")).toBe(false);
    expect(isExplicitSilentSentinel("")).toBe(false);

    expect(isPlaceholderEmptyReply("")).toBe(true);
    expect(isPlaceholderEmptyReply("   ")).toBe(true);
    expect(isPlaceholderEmptyReply("(no content)")).toBe(true);
    expect(isPlaceholderEmptyReply("No response requested.")).toBe(true);
    expect(isPlaceholderEmptyReply("已完成核对")).toBe(false);
  });

  it("classifies silent background turns accurately while respecting user-facing cards", () => {
    expect(
      isSilentBackgroundReply({
        assistantTexts: ["[SILENT]"],
        hadUserFacingCardTool: false,
      }),
    ).toBe(true);
    expect(
      isSilentBackgroundReply({
        assistantTexts: [],
        hadUserFacingCardTool: false,
      }),
    ).toBe(true);
    expect(
      isSilentBackgroundReply({
        assistantTexts: ["[SILENT]"],
        hadUserFacingCardTool: true,
      }),
    ).toBe(false);
    expect(
      isSilentBackgroundReply({
        assistantTexts: ["发现 1 个卡点需要您确认"],
        hadUserFacingCardTool: false,
      }),
    ).toBe(false);
  });

  it("triggers missing-reply recovery strictly once for non-canceled foreground tool turns with no visible reply", () => {
    expect(
      shouldRecoverMissingFinalReply({
        hadToolCalls: true,
        assistantTexts: [],
        canceled: false,
        failed: false,
        isBackground: false,
        isSilent: false,
        alreadyRecovered: false,
      }),
    ).toBe(true);

    expect(
      shouldRecoverMissingFinalReply({
        hadToolCalls: true,
        assistantTexts: ["(no content)"],
        canceled: false,
        failed: false,
        isBackground: false,
        isSilent: false,
        alreadyRecovered: false,
      }),
    ).toBe(true);

    // Anti-loop guard: already recovered once for this turn.
    expect(
      shouldRecoverMissingFinalReply({
        hadToolCalls: true,
        assistantTexts: [],
        canceled: false,
        failed: false,
        isBackground: false,
        isSilent: false,
        alreadyRecovered: true,
      }),
    ).toBe(false);

    // Do not recover when visible text exists, no tools ran, canceled/failed, background, or silent.
    expect(
      shouldRecoverMissingFinalReply({
        hadToolCalls: true,
        assistantTexts: ["已查完，问题定位在 config.ts"],
        canceled: false,
        failed: false,
        isBackground: false,
        isSilent: false,
        alreadyRecovered: false,
      }),
    ).toBe(false);
    expect(
      shouldRecoverMissingFinalReply({
        hadToolCalls: false,
        assistantTexts: [],
        canceled: false,
        failed: false,
        isBackground: false,
        isSilent: false,
        alreadyRecovered: false,
      }),
    ).toBe(false);
    expect(
      shouldRecoverMissingFinalReply({
        hadToolCalls: true,
        assistantTexts: [],
        canceled: true,
        failed: false,
        isBackground: false,
        isSilent: false,
        alreadyRecovered: false,
      }),
    ).toBe(false);
    expect(
      shouldRecoverMissingFinalReply({
        hadToolCalls: true,
        assistantTexts: ["[SILENT]"],
        canceled: false,
        failed: false,
        isBackground: false,
        isSilent: false,
        alreadyRecovered: false,
      }),
    ).toBe(false);
    expect(
      shouldRecoverMissingFinalReply({
        hadToolCalls: true,
        assistantTexts: [],
        canceled: false,
        failed: false,
        isBackground: true,
        isSilent: false,
        alreadyRecovered: false,
      }),
    ).toBe(false);

    const prompt = buildMissingReplyRecoveryPrompt();
    expect(prompt).toContain("不要再调用任何工具");
    expect(prompt).toContain("中文");
  });
});
