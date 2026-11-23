// @vitest-environment jsdom

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  createDefaultMainChatSettings,
  mergeMainChatSettings,
  type MainChatCustomStylePreset,
  type MainChatSettings,
  type MainChatSettingsPatch,
} from "@getpaseo/protocol/main-chat";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { MainChatSettingsSection } from "@/screens/settings/main-chat/main-chat-section";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import { MainChatHeroRow } from "./hero-row";
import { MainChatShell } from "./main-chat-shell";
import { useMainChatSettingsStore } from "./settings-store";

const mockRouterPush = vi.hoisted(() => vi.fn());
const mockHosts = vi.hoisted(() => [{ serverId: "srv_1", label: "DevBox" }]);

vi.mock("expo-router", () => ({
  router: {
    push: mockRouterPush,
    replace: vi.fn(),
    navigate: vi.fn(),
  },
  usePathname: () => "/main",
}));

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key,
      i18n: { language: "zh-CN" },
    }),
  };
});

vi.mock("@/constants/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants/layout")>();
  return {
    ...actual,
    useIsCompactFormFactor: () => false,
  };
});

vi.mock("@/hooks/use-shortcut-keys", () => ({
  useShortcutKeys: () => null,
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({ entries: [], isLoading: false }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => mockHosts,
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => ({ serverId: "srv_1", workspaceId: "ws_1" }),
  useLastWorkspaceSelection: () => ({ serverId: "srv_1", workspaceId: "ws_1" }),
}));

vi.mock("@/components/ui/modal", () => ({
  Modal: ({ visible, children }: { visible?: boolean; children: React.ReactNode }) =>
    visible ? React.createElement("div", { "data-testid": "mock-modal" }, children) : null,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuTrigger: ({
    children,
    testID,
    disabled,
  }: {
    children: React.ReactNode;
    testID?: string;
    disabled?: boolean;
  }) =>
    React.createElement("button", { type: "button", disabled, "data-testid": testID }, children),
  DropdownMenuContent: ({
    children,
    pages,
  }: {
    children: React.ReactNode;
    pages?: Array<{ id: string; content: React.ReactNode }>;
  }) =>
    React.createElement(
      "div",
      null,
      children,
      pages?.map((page) =>
        React.createElement("div", { key: page.id, "data-testid": `menu-page-${page.id}` }, page.content),
      ),
    ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuSubTrigger: ({
    children,
    value,
    testID,
  }: {
    children: React.ReactNode;
    value?: string;
    testID?: string;
  }) =>
    React.createElement("button", { type: "button", "data-testid": testID }, children, value),
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    testID,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        disabled,
        "data-testid": testID,
        onClick: () => {
          if (!disabled) onSelect?.();
        },
      },
      children,
    ),
  DropdownMenuSeparator: () => null,
}));

vi.mock("@/components/ui/select-field", () => ({
  SelectField: ({
    value,
    options,
    onChange,
    triggerTestID,
  }: {
    value: string | null;
    options: Array<{ id: string; value: string; label: string; testID?: string }>;
    onChange: (value: string, display: { label: string }) => void;
    triggerTestID?: string;
  }) =>
    React.createElement(
      "div",
      { "data-testid": triggerTestID, "data-value": value ?? "" },
      options.map((opt) =>
        React.createElement(
          "button",
          {
            key: opt.id,
            type: "button",
            "data-testid": opt.testID ?? `${triggerTestID ?? "select"}-opt-${opt.id}`,
            onClick: () => onChange(opt.value, { label: opt.label }),
          },
          opt.label,
        ),
      ),
    ),
}));

vi.mock("@/components/ui/form-field", () => ({
  Field: ({ label, children }: { label: string; children: React.ReactNode }) =>
    React.createElement("label", null, React.createElement("span", null, label), children),
  FormTextInput: ({
    initialValue,
    onChangeText,
    placeholder,
    testID,
  }: {
    initialValue?: string;
    onChangeText?: (text: string) => void;
    placeholder?: string;
    testID?: string;
  }) =>
    React.createElement("input", {
      defaultValue: initialValue ?? "",
      placeholder,
      "data-testid": testID,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText?.(event.target.value),
    }),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    value,
    disabled,
    onValueChange,
    testID,
  }: {
    value: boolean;
    disabled?: boolean;
    onValueChange?: (next: boolean) => void;
    testID?: string;
  }) =>
    React.createElement("input", {
      type: "checkbox",
      checked: value,
      disabled,
      "data-testid": testID,
      onChange: () => onValueChange?.(!value),
    }),
}));

vi.mock("./task-panel-drawer", () => ({
  TaskPanelDrawer: () => null,
}));

const noopToastApi = {
  show: vi.fn(),
  copied: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
  dismissAll: vi.fn(),
};

function makeStatefulClient(initialSettings: MainChatSettings) {
  let current = initialSettings;
  const updateMainChatSettings = vi.fn(async (patch: MainChatSettingsPatch) => {
    current = mergeMainChatSettings(current, patch);
    return {
      requestId: "req-upd",
      settings: current,
      nightModeStatus: {
        state: "active" as const,
        inNightWindow: false,
        effectivePatrolIntervalSec: current.intervals.patrolIntervalSec,
        nextTransitionAt: null,
        reason: null,
      },
      error: null,
    };
  });
  const getMainChatSettings = vi.fn(async () => ({
    requestId: "req-get",
    settings: current,
    nightModeStatus: {
      state: "active" as const,
      inNightWindow: false,
      effectivePatrolIntervalSec: current.intervals.patrolIntervalSec,
      nextTransitionAt: null,
      reason: null,
    },
    error: null,
  }));
  const getMainChatUsage = vi.fn(async () => ({
    requestId: "req-usage",
    usage: null,
    nightModeStatus: null,
    error: null,
  }));

  const client = {
    getMainChatSettings,
    updateMainChatSettings,
    getMainChatUsage,
    listMainChatStandingAuthorizations: vi.fn(async () => ({
      requestId: "req-auth",
      authorizations: [],
      suggestions: [],
      error: null,
    })),
    ensureMainChat: vi.fn(async () => ({
      requestId: "req-ensure",
      agentId: "agent_main",
      workspaceId: "ws_main",
      error: null,
    })),
    triggerMainChatPatrol: vi.fn(),
  } as unknown as DaemonClient;

  return { client, updateMainChatSettings, getCurrent: () => current };
}

function seedSession(serverId: string, client: DaemonClient) {
  const session: SessionState = {
    serverId,
    client,
    connectionStatus: "connected",
    serverInfo: {
      serverId,
      version: "0.17.515",
      features: { mainChat: true },
    } as unknown as SessionState["serverInfo"],
    agents: new Map(),
    workspaces: new Map(),
    projects: new Map(),
    pendingPermissions: new Map(),
  } as unknown as SessionState;
  useSessionStore.setState({ sessions: { [serverId]: session } });
}

function makeCustomPreset(
  overrides: Partial<MainChatCustomStylePreset> = {},
): MainChatCustomStylePreset {
  return {
    id: "custom-watch",
    name: "上线值守",
    description: "高频巡检且只汇报红线与故障",
    baseStyle: "conservative",
    customGuidance: "只汇报故障和阻塞，结论在三行内",
    intervals: {
      patrolIntervalSec: 25,
      triageSettleSec: 15,
      stalledThresholdMin: 8,
      noProgressThresholdMin: 6,
      needsYouEscalateMin: 2,
      wakeupCooldownMin: 4,
    },
    capabilities: {
      semanticTriageEnabled: true,
      proactiveWakeupEnabled: true,
      initialBriefingEnabled: true,
      autoContinueManualErrors: true,
      autoDelegateManualQuestions: false,
      autoNudgeManualStalled: false,
    },
    ...overrides,
  };
}

describe("Main Chat custom style presets UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({ sessions: {} });
    useMainChatSettingsStore.setState({
      settingsByServerId: {},
      nightModeStatusByServerId: {},
      usageByServerId: {},
      usageLoadingByServerId: {},
      loadingByServerId: {},
      lastPatrolByServerId: {},
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a single compact style selector card, creates from template, edits, deletes, and resets to default", async () => {
    const initial = createDefaultMainChatSettings("conservative");
    const { client, updateMainChatSettings } = makeStatefulClient(initial);
    seedSession("srv_1", client);
    useMainChatSettingsStore.setState({ settingsByServerId: { srv_1: initial } });

    const view = render(
      <ToastApiProvider api={noopToastApi}>
        <MainChatSettingsSection />
      </ToastApiProvider>,
    );

    // Compact selector card renders; modified bar is hidden when pristine
    expect(view.getByTestId("settings-main-chat-style-card")).toBeTruthy();
    expect(view.getByTestId("settings-main-chat-style-select")).toBeTruthy();
    expect(view.queryByTestId("settings-main-chat-style-modified-bar")).toBeNull();

    // Open New Preset modal, pick proactive template, fill name & guidance, expand advanced and tweak interval
    fireEvent.click(view.getByTestId("settings-main-chat-style-new"));
    expect(view.getByTestId("style-preset-editor-modal")).toBeTruthy();

    fireEvent.click(view.getByTestId("style-preset-editor-template-trigger-opt-proactive"));
    fireEvent.change(view.getByTestId("style-preset-editor-name"), {
      target: { value: "上线值守" },
    });
    fireEvent.change(view.getByTestId("style-preset-editor-description"), {
      target: { value: "上线日快速监控" },
    });
    fireEvent.change(view.getByTestId("style-preset-editor-guidance"), {
      target: { value: "优先汇报 CI 与部署错误" },
    });
    fireEvent.click(view.getByTestId("style-preset-editor-advanced-toggle"));
    expect(view.getByTestId("style-preset-editor-advanced-body")).toBeTruthy();
    fireEvent.change(view.getByTestId("style-preset-editor-interval-patrolIntervalSec"), {
      target: { value: "25" },
    });

    await act(async () => {
      fireEvent.click(view.getByTestId("style-preset-editor-submit"));
    });

    await waitFor(() => {
      expect(updateMainChatSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          upsertCustomPreset: expect.objectContaining({
            name: "上线值守",
            description: "上线日快速监控",
            baseStyle: "proactive",
            customGuidance: "优先汇报 CI 与部署错误",
            intervals: expect.objectContaining({ patrolIntervalSec: 25 }),
          }),
          applyPresetId: expect.stringMatching(/^custom-/),
        }),
      );
    });

    // Guidance preview is shown on the compact card
    await waitFor(() => {
      expect(view.getByTestId("settings-main-chat-style-guidance")).toBeTruthy();
    });

    // Edit active custom preset
    fireEvent.click(view.getByTestId("settings-main-chat-style-edit"));
    fireEvent.change(view.getByTestId("style-preset-editor-name"), {
      target: { value: "发布值守 Pro" },
    });
    await act(async () => {
      fireEvent.click(view.getByTestId("style-preset-editor-submit"));
    });
    await waitFor(() => {
      expect(updateMainChatSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({
          upsertCustomPreset: expect.objectContaining({ name: "发布值守 Pro" }),
        }),
      );
    });

    // Reset to factory default preserves custom presets while restoring conservative
    await act(async () => {
      fireEvent.click(view.getByTestId("settings-main-chat-style-reset-default"));
    });
    await waitFor(() => {
      expect(updateMainChatSettings).toHaveBeenLastCalledWith({ resetStyleToDefault: true });
    });

    // Switch back to custom preset then delete with confirmation
    const createdId = useMainChatSettingsStore.getState().settingsByServerId.srv_1
      ?.customPresets?.[0]?.id;
    expect(createdId).toBeTruthy();
    await act(async () => {
      fireEvent.click(view.getByTestId(`settings-main-chat-preset-option-${createdId}`));
    });
    await waitFor(() => {
      expect(view.getByTestId("settings-main-chat-style-delete")).toBeTruthy();
    });
    fireEvent.click(view.getByTestId("settings-main-chat-style-delete"));
    expect(view.getByTestId("style-preset-delete-modal")).toBeTruthy();
    await act(async () => {
      fireEvent.click(view.getByTestId("style-preset-delete-confirm"));
    });
    await waitFor(() => {
      expect(updateMainChatSettings).toHaveBeenLastCalledWith({
        deleteCustomPresetId: createdId,
      });
    });
  });

  it("reveals contextual modified bar only after tuning parameters, supporting restore and overwrite", async () => {
    const custom = makeCustomPreset();
    const tweaked = mergeMainChatSettings(
      mergeMainChatSettings(createDefaultMainChatSettings(), {
        upsertCustomPreset: custom,
        applyPresetId: custom.id,
      }),
      { intervals: { patrolIntervalSec: 90 } },
    );
    const { client, updateMainChatSettings } = makeStatefulClient(tweaked);
    seedSession("srv_1", client);
    useMainChatSettingsStore.setState({ settingsByServerId: { srv_1: tweaked } });

    const view = render(
      <ToastApiProvider api={noopToastApi}>
        <MainChatSettingsSection />
      </ToastApiProvider>,
    );

    expect(view.getByTestId("settings-main-chat-style-modified-bar")).toBeTruthy();
    expect(view.getByTestId("settings-main-chat-style-restore-inline")).toBeTruthy();
    expect(view.getByTestId("settings-main-chat-style-overwrite-inline")).toBeTruthy();

    await act(async () => {
      fireEvent.click(view.getByTestId("settings-main-chat-style-overwrite-inline"));
    });

    await waitFor(() => {
      expect(updateMainChatSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          upsertCustomPreset: expect.objectContaining({
            id: custom.id,
            intervals: expect.objectContaining({ patrolIntervalSec: 90 }),
          }),
          applyPresetId: custom.id,
        }),
      );
    });

    // Once saved back to the preset, the modified bar disappears cleanly
    await waitFor(() => {
      expect(view.queryByTestId("settings-main-chat-style-modified-bar")).toBeNull();
    });
  });

  it("shows custom preset in MainChatShell header switcher and MainChatHeroRow submenu", async () => {
    const custom = makeCustomPreset();
    const withCustom = mergeMainChatSettings(createDefaultMainChatSettings(), {
      upsertCustomPreset: custom,
      applyPresetId: custom.id,
    });
    const { client, updateMainChatSettings } = makeStatefulClient(withCustom);
    seedSession("srv_1", client);
    useMainChatSettingsStore.setState({ settingsByServerId: { srv_1: withCustom } });

    const shellView = render(
      <ToastApiProvider api={noopToastApi}>
        <MainChatShell
          variant="main"
          title="对话管理"
          serverId="srv_1"
          mainAgentId="agent_main"
          originRoute="/main"
        >
          <div />
        </MainChatShell>
      </ToastApiProvider>,
    );

    expect(shellView.getByTestId("main-chat-style-capsule").textContent).toContain("上线值守");
    expect(shellView.getByTestId("main-chat-style-option-custom-watch")).toBeTruthy();

    await act(async () => {
      fireEvent.click(shellView.getByTestId("main-chat-style-option-proactive"));
    });
    await waitFor(() => {
      expect(updateMainChatSettings).toHaveBeenCalledWith({ applyPresetId: "proactive" });
    });

    cleanup();

    const heroView = render(
      <KeyboardActionDispatcherProvider>
        <ToastApiProvider api={noopToastApi}>
          <MainChatHeroRow />
        </ToastApiProvider>
      </KeyboardActionDispatcherProvider>,
    );

    // Submenu trigger renders when custom presets exist
    expect(heroView.getByTestId("sidebar-main-chat-hero-style-submenu")).toBeTruthy();
    expect(heroView.getByTestId("sidebar-main-chat-hero-style-custom-watch")).toBeTruthy();

    await act(async () => {
      fireEvent.click(heroView.getByTestId("sidebar-main-chat-hero-style-custom-watch"));
    });
    await waitFor(() => {
      expect(updateMainChatSettings).toHaveBeenLastCalledWith({
        applyPresetId: "custom-watch",
      });
    });
  });
});
