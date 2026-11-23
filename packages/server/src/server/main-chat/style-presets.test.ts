import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAIN_CHAT_MAX_CUSTOM_STYLE_PRESETS,
  MAIN_CHAT_STYLE_PRESETS,
  createDefaultMainChatSettings,
  createMainChatCustomPresetId,
  isMainChatStyleFactoryDefault,
  isMainChatStyleModified,
  mergeMainChatSettings,
  resolveActiveMainChatStylePreset,
  type MainChatCustomStylePreset,
} from "@getpaseo/protocol/main-chat";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMainChatInitialBriefingPrompt,
  buildMainChatPatrolWakeupPrompt,
  buildMainChatSupervisionWakeupPrompt,
  buildMainChatSystemPrompt,
} from "./prompts.js";
import { createMainChatStore } from "./store.js";

function makeCustomPreset(
  overrides: Partial<MainChatCustomStylePreset> = {},
): MainChatCustomStylePreset {
  return {
    id: "custom-launch-watch",
    name: "上线日盯盘",
    description: "高频巡检 CI 与异常，但保持手动会话仅汇报不代答",
    baseStyle: "conservative",
    customGuidance: "仅在构建失败、卡点或需要我拍板时提醒，汇报不超过 3 行。",
    intervals: {
      patrolIntervalSec: 25,
      triageSettleSec: 12,
      stalledThresholdMin: 8,
      noProgressThresholdMin: 5,
      needsYouEscalateMin: 2,
      wakeupCooldownMin: 3,
    },
    capabilities: {
      semanticTriageEnabled: true,
      proactiveWakeupEnabled: true,
      initialBriefingEnabled: true,
      autoContinueManualErrors: true,
      autoDelegateManualQuestions: false,
      autoNudgeManualStalled: false,
    },
    updatedAt: "2026-11-24T02:00:00.000Z",
    ...overrides,
  };
}

describe("Main Chat custom style presets — protocol, store persistence & prompts", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("supports creating, updating, applying, detecting modifications, deleting, and resetting presets", () => {
    const initial = createDefaultMainChatSettings("conservative");
    expect(isMainChatStyleFactoryDefault(initial)).toBe(true);
    expect(isMainChatStyleModified(initial)).toBe(false);

    // Create + apply custom preset atomically
    const launchPreset = makeCustomPreset();
    const afterCreate = mergeMainChatSettings(initial, {
      upsertCustomPreset: launchPreset,
      applyPresetId: launchPreset.id,
    });
    expect(afterCreate.activePresetId).toBe(launchPreset.id);
    expect(afterCreate.style).toBe("conservative");
    expect(afterCreate.intervals.patrolIntervalSec).toBe(25);
    expect(afterCreate.customPresets).toHaveLength(1);
    expect(isMainChatStyleModified(afterCreate)).toBe(false);
    expect(isMainChatStyleFactoryDefault(afterCreate)).toBe(false);

    // Fine-tune interval below preset -> detected as modified
    const afterTweak = mergeMainChatSettings(afterCreate, {
      intervals: { patrolIntervalSec: 45 },
    });
    expect(afterTweak.activePresetId).toBe(launchPreset.id);
    expect(isMainChatStyleModified(afterTweak)).toBe(true);

    // Restore active custom preset -> returns to preset snapshot
    const afterRestore = mergeMainChatSettings(afterTweak, {
      applyPresetId: launchPreset.id,
    });
    expect(afterRestore.intervals.patrolIntervalSec).toBe(25);
    expect(isMainChatStyleModified(afterRestore)).toBe(false);

    // Update existing custom preset in place + apply updated values
    const updatedPreset = makeCustomPreset({
      name: "上线日极速盯盘",
      baseStyle: "proactive",
      intervals: { ...launchPreset.intervals, patrolIntervalSec: 20 },
      capabilities: { ...launchPreset.capabilities, autoNudgeManualStalled: true },
    });
    const afterUpdate = mergeMainChatSettings(afterRestore, {
      upsertCustomPreset: updatedPreset,
      applyPresetId: updatedPreset.id,
    });
    expect(afterUpdate.customPresets).toHaveLength(1);
    expect(afterUpdate.style).toBe("proactive");
    expect(afterUpdate.intervals.patrolIntervalSec).toBe(20);
    expect(afterUpdate.capabilities.autoNudgeManualStalled).toBe(true);
    expect(resolveActiveMainChatStylePreset(afterUpdate).name).toBe("上线日极速盯盘");

    // Reset to factory default -> reverts style/intervals/capabilities while keeping customPresets & title
    const withCustomTitle = mergeMainChatSettings(afterUpdate, { title: "我的管家" });
    const afterFactoryReset = mergeMainChatSettings(withCustomTitle, {
      resetStyleToDefault: true,
    });
    expect(afterFactoryReset.title).toBe("我的管家");
    expect(afterFactoryReset.activePresetId).toBe("conservative");
    expect(afterFactoryReset.style).toBe("conservative");
    expect(afterFactoryReset.intervals).toEqual(MAIN_CHAT_STYLE_PRESETS.conservative.intervals);
    expect(afterFactoryReset.capabilities).toEqual(
      MAIN_CHAT_STYLE_PRESETS.conservative.capabilities,
    );
    expect(afterFactoryReset.customPresets).toHaveLength(1);
    expect(isMainChatStyleFactoryDefault(afterFactoryReset)).toBe(true);

    // Switch back to custom preset, then delete active custom preset -> falls back safely to baseStyle
    const reapplied = mergeMainChatSettings(afterFactoryReset, {
      applyPresetId: updatedPreset.id,
    });
    const afterDelete = mergeMainChatSettings(reapplied, {
      deleteCustomPresetId: updatedPreset.id,
    });
    expect(afterDelete.customPresets).toHaveLength(0);
    expect(afterDelete.activePresetId).toBe("proactive");
    expect(afterDelete.style).toBe("proactive");
    expect(afterDelete.intervals.patrolIntervalSec).toBe(20);
  });

  it("protects built-in presets from overwrite/delete and enforces max custom preset limit", () => {
    const initial = createDefaultMainChatSettings();

    expect(() =>
      mergeMainChatSettings(initial, {
        upsertCustomPreset: makeCustomPreset({ id: "conservative", name: "Fake" }),
      }),
    ).toThrow(/built-in/i);

    const afterAttemptDeleteBuiltIn = mergeMainChatSettings(initial, {
      deleteCustomPresetId: "conservative",
    });
    expect(afterAttemptDeleteBuiltIn.activePresetId).toBe("conservative");

    // Fill up to limit
    let state = initial;
    for (let i = 0; i < MAIN_CHAT_MAX_CUSTOM_STYLE_PRESETS; i += 1) {
      state = mergeMainChatSettings(state, {
        upsertCustomPreset: makeCustomPreset({
          id: `custom-preset-${i}`,
          name: `预设 ${i + 1}`,
        }),
      });
    }
    expect(state.customPresets).toHaveLength(MAIN_CHAT_MAX_CUSTOM_STYLE_PRESETS);

    expect(() =>
      mergeMainChatSettings(state, {
        upsertCustomPreset: makeCustomPreset({
          id: "custom-preset-overflow",
          name: "超出上限",
        }),
      }),
    ).toThrow(/limit/i);

    // ID generator avoids collisions and built-in names
    const generated1 = createMainChatCustomPresetId("Conservative", []);
    expect(generated1).toBe("custom-conservative");
    const generated2 = createMainChatCustomPresetId("Conservative", [generated1]);
    expect(generated2).toBe("custom-conservative-2");
    const generatedCn = createMainChatCustomPresetId("夜间安静值守", []);
    expect(generatedCn).toBe("custom-style");
  });

  it("persists custom presets and activePresetId across store reload", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "paseo-main-chat-presets-"));
    tempDirs.push(tempDir);

    const store1 = createMainChatStore(tempDir);
    await store1.load();
    const custom = makeCustomPreset();
    await store1.updateSettings({
      upsertCustomPreset: custom,
      applyPresetId: custom.id,
    });

    const store2 = createMainChatStore(tempDir);
    await store2.load();
    const reloaded = store2.getSettings();
    expect(reloaded.activePresetId).toBe(custom.id);
    expect(reloaded.customPresets).toHaveLength(1);
    expect(reloaded.customPresets?.[0]?.name).toBe(custom.name);
    expect(reloaded.customPresets?.[0]?.customGuidance).toBe(custom.customGuidance);
    expect(reloaded.intervals.patrolIntervalSec).toBe(25);
  });

  it("injects active custom preset name and customGuidance into system, wakeup, and briefing prompts", () => {
    const custom = makeCustomPreset({
      name: "安静值守",
      customGuidance: "只报告阻塞项，每次回复控制在三行以内。",
    });
    const settings = mergeMainChatSettings(createDefaultMainChatSettings(), {
      upsertCustomPreset: custom,
      applyPresetId: custom.id,
    });

    const systemPrompt = buildMainChatSystemPrompt(settings);
    expect(systemPrompt).toContain("自定义预设「安静值守」");
    expect(systemPrompt).toContain("只报告阻塞项，每次回复控制在三行以内。");

    const patrolPrompt = buildMainChatPatrolWakeupPrompt({
      settings,
      signals: [],
      contextSnapshot: "<paseo-main-context/>",
    });
    expect(patrolPrompt).toContain("自定义预设「安静值守」");
    expect(patrolPrompt).toContain("只报告阻塞项，每次回复控制在三行以内。");

    const supervisionPrompt = buildMainChatSupervisionWakeupPrompt({
      settings,
      signals: [],
      contextSnapshot: "<paseo-main-context/>",
    });
    expect(supervisionPrompt).toContain("自定义预设「安静值守」");
    expect(supervisionPrompt).toContain("只报告阻塞项，每次回复控制在三行以内。");

    const briefingPrompt = buildMainChatInitialBriefingPrompt({
      settings,
      contextSnapshot: "<paseo-main-context/>",
    });
    expect(briefingPrompt).toContain("自定义预设「安静值守」");
    expect(briefingPrompt).toContain("只报告阻塞项，每次回复控制在三行以内。");
  });
});
