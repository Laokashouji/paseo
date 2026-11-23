/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zhCN } from "@/i18n/resources/zh-CN";
import { useSessionStore } from "@/stores/session-store";

const {
  confirmDialogMock,
  toastShowMock,
  toastErrorMock,
  useAppSettingsMock,
  useInstalledPluginMock,
} = vi.hoisted(() => ({
  confirmDialogMock: vi.fn(),
  toastShowMock: vi.fn(),
  toastErrorMock: vi.fn(),
  useAppSettingsMock: vi.fn(),
  useInstalledPluginMock: vi.fn(),
}));

function lookupZhCN(key: string): string {
  let cursor: unknown = zhCN;
  for (const segment of key.split(".")) {
    if (!cursor || typeof cursor !== "object") return key;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === "string" ? cursor : key;
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: lookupZhCN }),
}));

vi.mock("lucide-react-native", () => ({
  Archive: () => null,
}));

function createSubscribeHandle() {
  return Object.assign(vi.fn(), { ready: Promise.resolve() });
}

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
    testID,
  }: {
    children:
      | React.ReactNode
      | ((state: { pressed: boolean; hovered: boolean }) => React.ReactNode);
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    testID?: string;
  }) => (
    <button
      type="button"
      data-testid={testID}
      aria-label={accessibilityLabel}
      aria-disabled={disabled}
      onClick={onPress}
    >
      {typeof children === "function" ? children({ pressed: false, hovered: false }) : children}
    </button>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="archive-tooltip-content">{children}</div>
  ),
}));

vi.mock("@/composer/tracks", () => ({
  ComposerTrackMark: () => null,
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({
    show: toastShowMock,
    error: toastErrorMock,
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useAppSettings: () => useAppSettingsMock(),
}));

vi.mock("@/plugins/registry", () => ({
  useInstalledPlugin: (...args: unknown[]) => useInstalledPluginMock(...args),
}));

vi.mock("@/utils/confirm-dialog", () => ({
  confirmDialog: (...args: unknown[]) => confirmDialogMock(...args),
}));

import { ArchiveConversationButton } from "./archive-button";

const SERVER_ID = "srv-archive-test";
const WORKSPACE_ID = "ws-archive-test";
const AGENT_ID = "agent-archive-test";

describe("ArchiveConversationButton", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.clearAllMocks();
    useAppSettingsMock.mockReturnValue({
      settings: {
        archiveCommand: "请归档当前对话",
        autoArchiveAfterCleanup: true,
      },
    });
    useSessionStore
      .getState()
      .initializeSession(SERVER_ID, { sendMessage: vi.fn() } as unknown as DaemonClient);
  });

  afterEach(() => {
    cleanup();
    useSessionStore.getState().clearSession(SERVER_ID);
  });

  it("shows the simplified Chinese hover tooltip and dispatches directly without confirmation", async () => {
    const invoke = vi.fn().mockResolvedValue({ state: "running", status: "sent" });
    const subscribe = vi.fn(createSubscribeHandle);
    useInstalledPluginMock.mockReturnValue({ invoke, subscribe });

    const view = render(
      <ArchiveConversationButton
        serverId={SERVER_ID}
        workspaceId={WORKSPACE_ID}
        agentId={AGENT_ID}
      />,
    );

    const button = view.getByTestId("archive-conversation-button");
    expect(button.getAttribute("aria-label")).toBe("让AI归档当前对话");
    expect(view.getByTestId("archive-tooltip-content").textContent).toBe("让AI归档当前对话");

    fireEvent.click(button);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledTimes(1);
    });
    expect(confirmDialogMock).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("session.archive.trigger", {
      agentId: AGENT_ID,
      workspaceId: WORKSPACE_ID,
      command: "请归档当前对话",
      autoArchiveAfterCleanup: true,
    });
    expect(toastShowMock).toHaveBeenCalledWith(zhCN.sessionArchive.toasts.sent, {
      variant: "success",
    });
  });

  it("ignores duplicate rapid clicks while the first archive trigger is in flight", async () => {
    let resolveInvoke!: (value: { state: string; status: string }) => void;
    const pendingTrigger = new Promise<{ state: string; status: string }>((resolve) => {
      resolveInvoke = resolve;
    });
    const invoke = vi.fn().mockReturnValue(pendingTrigger);
    const subscribe = vi.fn(createSubscribeHandle);
    useInstalledPluginMock.mockReturnValue({ invoke, subscribe });

    const view = render(
      <ArchiveConversationButton
        serverId={SERVER_ID}
        workspaceId={WORKSPACE_ID}
        agentId={AGENT_ID}
      />,
    );

    const button = view.getByTestId("archive-conversation-button");
    fireEvent.click(button);
    fireEvent.click(button);

    expect(invoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInvoke({ state: "running", status: "sent" });
    });
    expect(confirmDialogMock).not.toHaveBeenCalled();
  });

  it("falls back to direct client.sendMessage without confirmation when plugin is absent", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    useSessionStore.getState().clearSession(SERVER_ID);
    useSessionStore
      .getState()
      .initializeSession(SERVER_ID, { sendMessage } as unknown as DaemonClient);
    useInstalledPluginMock.mockReturnValue(null);

    const view = render(
      <ArchiveConversationButton
        serverId={SERVER_ID}
        workspaceId={WORKSPACE_ID}
        agentId={AGENT_ID}
      />,
    );

    fireEvent.click(view.getByTestId("archive-conversation-button"));

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(confirmDialogMock).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(AGENT_ID, "请归档当前对话");
  });

  it("still confirms before canceling a queued archive command", async () => {
    let emitState: ((payload: { state: string }) => void) | undefined;
    const invoke = vi.fn().mockResolvedValue({ state: "idle", status: "canceled" });
    const subscribe = vi.fn(
      (
        _name: string,
        _input: unknown,
        handlers: { event: (payload: { state: string }) => void },
      ) => {
        emitState = handlers.event;
        return createSubscribeHandle();
      },
    );
    useInstalledPluginMock.mockReturnValue({ invoke, subscribe });
    confirmDialogMock.mockResolvedValueOnce(true);

    const view = render(
      <ArchiveConversationButton
        serverId={SERVER_ID}
        workspaceId={WORKSPACE_ID}
        agentId={AGENT_ID}
      />,
    );

    act(() => {
      emitState?.({ state: "queued" });
    });

    fireEvent.click(view.getByTestId("archive-conversation-button"));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("session.archive.trigger", {
        agentId: AGENT_ID,
        workspaceId: WORKSPACE_ID,
        cancelQueue: true,
      });
    });
    expect(confirmDialogMock).toHaveBeenCalledTimes(1);
  });
});
