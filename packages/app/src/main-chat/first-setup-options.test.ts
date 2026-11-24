import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import {
  buildMainChatFirstSetupSubmission,
  getModelThinkingOptions,
  getProviderAvailableModes,
  reconcileModeId,
  reconcileThinkingOptionId,
  resolveDefaultModeId,
  resolveDefaultThinkingOptionId,
  resolveModelDefinitionFromEntry,
  resolveProviderSnapshotEntryByProvider,
} from "./first-setup-options";

const CLAUDE_ENTRY: ProviderSnapshotEntry = {
  provider: "claude",
  label: "Claude Code",
  enabled: true,
  status: "ready",
  defaultModeId: "acceptEdits",
  modes: [
    { id: "default", label: "Ask before editing", description: "Ask before running tools" },
    { id: "acceptEdits", label: "Edit automatically", description: "Auto-approve file edits" },
    { id: "bypassPermissions", label: "Full access", description: "Run without prompts" },
  ],
  models: [
    {
      provider: "claude",
      id: "claude-opus-5-5",
      aliases: ["opus"],
      label: "Claude Opus 5.5",
      isDefault: true,
      defaultThinkingOptionId: "high",
      thinkingOptions: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "max", label: "Max" },
      ],
    },
    {
      provider: "claude",
      id: "claude-haiku-legacy",
      label: "Claude Haiku Legacy",
      thinkingOptions: [],
    },
  ],
};

const MINIMAL_PROVIDER_ENTRY: ProviderSnapshotEntry = {
  provider: "custom-minimal",
  label: "Custom Minimal",
  enabled: true,
  status: "ready",
  models: [
    {
      provider: "custom-minimal",
      id: "fast-v1",
      label: "Fast v1",
      isDefault: true,
    },
  ],
};

describe("first-setup-options", () => {
  it("resolves provider entries, model definitions (including aliases), and defaults from snapshot", () => {
    const entries = [CLAUDE_ENTRY, MINIMAL_PROVIDER_ENTRY];
    const claude = resolveProviderSnapshotEntryByProvider(entries, "claude");
    expect(claude).toBe(CLAUDE_ENTRY);

    const byAlias = resolveModelDefinitionFromEntry(claude, "opus");
    expect(byAlias?.id).toBe("claude-opus-5-5");
    expect(resolveDefaultThinkingOptionId(byAlias)).toBe("high");
    expect(resolveDefaultModeId(claude)).toBe("acceptEdits");

    const fallbackModel = resolveModelDefinitionFromEntry(claude, "");
    expect(fallbackModel?.id).toBe("claude-opus-5-5");
  });

  it("reconciles thinking and mode options cleanly when switching models or providers", () => {
    const opus = resolveModelDefinitionFromEntry(CLAUDE_ENTRY, "claude-opus-5-5");
    const haiku = resolveModelDefinitionFromEntry(CLAUDE_ENTRY, "claude-haiku-legacy");

    expect(reconcileThinkingOptionId("max", opus)).toBe("max");
    expect(reconcileThinkingOptionId("nonexistent", opus)).toBe("high");
    expect(reconcileThinkingOptionId("max", haiku)).toBe("");
    expect(getModelThinkingOptions(haiku)).toHaveLength(0);

    expect(reconcileModeId("bypassPermissions", CLAUDE_ENTRY)).toBe("bypassPermissions");
    expect(reconcileModeId("unknown-mode", CLAUDE_ENTRY)).toBe("acceptEdits");
    expect(reconcileModeId("bypassPermissions", MINIMAL_PROVIDER_ENTRY)).toBe("");
    expect(getProviderAvailableModes(MINIMAL_PROVIDER_ENTRY)).toHaveLength(0);
  });

  it("builds validated submission payloads and omits unsupported thinking/mode fields", () => {
    expect(
      buildMainChatFirstSetupSubmission({
        provider: "claude",
        model: "claude-opus-5-5",
        thinkingOptionId: "max",
        modeId: "bypassPermissions",
        entry: CLAUDE_ENTRY,
      }),
    ).toEqual({
      provider: "claude",
      model: "claude-opus-5-5",
      thinkingOptionId: "max",
      modeId: "bypassPermissions",
    });

    // Model without thinkingOptions omits thinkingOptionId while keeping valid modeId.
    expect(
      buildMainChatFirstSetupSubmission({
        provider: "claude",
        model: "claude-haiku-legacy",
        thinkingOptionId: "max",
        modeId: "default",
        entry: CLAUDE_ENTRY,
      }),
    ).toEqual({
      provider: "claude",
      model: "claude-haiku-legacy",
      modeId: "default",
    });

    // Provider without modes or thinking options omits both fields.
    expect(
      buildMainChatFirstSetupSubmission({
        provider: "custom-minimal",
        model: "fast-v1",
        thinkingOptionId: "high",
        modeId: "auto",
        entry: MINIMAL_PROVIDER_ENTRY,
      }),
    ).toEqual({
      provider: "custom-minimal",
      model: "fast-v1",
    });
  });
});
