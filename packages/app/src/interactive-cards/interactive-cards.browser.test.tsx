import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  computeInlineCardKey,
  type InteractiveCardView,
} from "@getpaseo/protocol/interactive-cards";
import type { MainChatOverview } from "@getpaseo/protocol/main-chat";
import { i18n as testI18n } from "@/i18n/i18next";
import { useMainChatDrawerStore } from "@/main-chat/drawer-store";
import { overviewStoreKey, useMainChatOverviewStore } from "@/main-chat/overview-store";
import { MainChatShellProvider } from "@/main-chat/shell-context";
import { useSessionStore } from "@/stores/session-store";
import { InteractiveCardContext, type InteractiveCardHostContextValue } from "./context";
import { InteractiveInlineCardFence } from "./inline-fence";
import { renderInteractiveToolCard } from "./live-card";
import { applyAgentCardsSnapshot, resetInteractiveCardsStore } from "./store";

void testI18n;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const READ_ONLY_HOST: InteractiveCardHostContextValue = {
  serverId: "srv-1",
  agentId: "ag-3",
  client: null,
  interactive: false,
};

const MAIN_CHAT_SHELL_VALUE = {
  inMainChatShell: true,
  originRoute: "/main",
  originTitle: "管家",
};

function TestHostProvider({
  host,
  children,
}: {
  host: InteractiveCardHostContextValue;
  children: React.ReactElement;
}) {
  return <InteractiveCardContext.Provider value={host}>{children}</InteractiveCardContext.Provider>;
}

function createTestHost(
  overrides: Partial<InteractiveCardHostContextValue> & {
    serverId: string;
    agentId: string;
  },
): InteractiveCardHostContextValue {
  return {
    client: null,
    interactive: true,
    ...overrides,
  };
}

function mountWithHost(host: InteractiveCardHostContextValue, element: React.ReactElement) {
  return mount(<TestHostProvider host={host}>{element}</TestHostProvider>);
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  resetInteractiveCardsStore();
});

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mount(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return { container, queries: within(container) };
}

describe("Interactive cards (browser)", () => {
  it("renders inline choice rows, submits once, locks the card, and shows Sent status", async () => {
    const submitMock = vi.fn<DaemonClient["submitAgentCard"]>(async (req) => ({
      requestId: "req-1",
      agentId: req.agentId,
      cardKey: req.cardKey,
      ok: true,
      action: {
        cardKey: req.cardKey,
        actionId: req.actionId,
        version: req.expectedVersion,
        clientMessageId: req.clientMessageId,
        text: "Adjust permissions",
        status: "sent",
        revision: 2,
        createdAt: "2026-11-24T00:00:00.000Z",
        updatedAt: "2026-11-24T00:00:00.000Z",
      },
    }));

    const view: InteractiveCardView = {
      title: "Start Proactive Mode",
      fallback: "Pick an onboarding step",
      sections: [
        {
          items: [
            {
              type: "row",
              title: "Full Guided Setup",
              subtitle: "Profile + Patrol + Automation",
              action: { kind: "reply", id: "opt-full", reply: "Start full setup" },
            },
            {
              type: "row",
              title: "Raise Agent Autonomy",
              subtitle: "Enable auto-supervise and trusted dirs",
              action: { kind: "reply", id: "opt-autonomy", reply: "Adjust permissions" },
            },
          ],
        },
      ],
    };

    const rawJson = JSON.stringify(view);
    const messageText = `Choose a step:\n\`\`\`paseo-view\n${rawJson}\n\`\`\``;
    const cardKey = computeInlineCardKey(messageText, 0);

    applyAgentCardsSnapshot("srv-1", "ag-1", {
      views: [],
      inlineBlockKeys: [cardKey],
      actions: [],
    });

    const hostValue = createTestHost({
      serverId: "srv-1",
      agentId: "ag-1",
      client: { submitAgentCard: submitMock } as unknown as DaemonClient,
      messageText,
      interactive: true,
    });

    const { queries } = mountWithHost(hostValue, <InteractiveInlineCardFence code={rawJson} />);

    const row = queries.getByTestId("interactive-card-row-opt-autonomy");
    await act(async () => {
      fireEvent.click(row);
    });

    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0]?.[0]).toMatchObject({
      agentId: "ag-1",
      cardKey,
      actionId: "opt-autonomy",
      expectedVersion: 1,
    });
    expect(queries.getByTestId("interactive-card-status")).toBeTruthy();
  });

  it("renders live card with toggles, form submit, charts, table, and multi-page drill-down", async () => {
    const submitMock = vi.fn<DaemonClient["submitAgentCard"]>(async (req) => ({
      requestId: "req-2",
      agentId: req.agentId,
      cardKey: req.cardKey,
      ok: true,
      action: {
        cardKey: req.cardKey,
        actionId: req.actionId,
        values: req.values,
        version: req.expectedVersion,
        clientMessageId: req.clientMessageId,
        text: "Apply settings",
        status: "sent",
        revision: 2,
        createdAt: "2026-11-24T00:00:00.000Z",
        updatedAt: "2026-11-24T00:00:00.000Z",
      },
    }));

    const liveView: InteractiveCardView = {
      title: "Automation Controls",
      fallback: "Adjust automation toggles",
      sections: [
        {
          items: [
            {
              type: "field",
              name: "supervise",
              label: "Auto supervise",
              kind: "toggle",
              value: "true",
            },
            {
              type: "field",
              name: "autoClose",
              label: "Auto close idle terminals",
              kind: "toggle",
              value: "false",
            },
            {
              type: "field",
              name: "mode",
              label: "Approval mode",
              kind: "choice",
              value: "ask",
              options: [
                { value: "ask", label: "Ask first" },
                { value: "auto", label: "Auto run" },
              ],
            },
            {
              type: "button",
              label: "View Metrics",
              variant: "secondary",
              action: { kind: "push_page", id: "open-metrics", page: "metrics" },
            },
            {
              type: "button",
              label: "Apply Changes",
              variant: "primary",
              action: { kind: "reply", id: "submit-form", reply: "Apply settings", submit: true },
            },
          ],
        },
      ],
      pages: {
        metrics: {
          title: "Weekly Metrics",
          sections: [
            {
              items: [
                {
                  type: "chart",
                  chartType: "bar",
                  categories: ["Mon", "Tue", "Wed"],
                  series: [{ name: "Tasks", values: [4, 7, 5] }],
                },
                {
                  type: "table",
                  columns: [
                    { key: "host", label: "Host", sortable: true },
                    { key: "runs", label: "Runs", align: "right", sortable: true },
                  ],
                  rows: [
                    { host: "DevBox", runs: 12 },
                    { host: "MacBook", runs: 4 },
                  ],
                },
              ],
            },
          ],
        },
      },
    };

    const cardId = "view_112233445566";
    applyAgentCardsSnapshot("srv-1", "ag-2", {
      views: [
        {
          id: cardId,
          agentId: "ag-2",
          version: 1,
          view: liveView,
          createdAt: "2026-11-24T00:00:00.000Z",
          updatedAt: "2026-11-24T00:00:00.000Z",
        },
      ],
      inlineBlockKeys: [],
      actions: [],
    });

    const node = renderInteractiveToolCard({
      serverId: "srv-1",
      agentId: "ag-2",
      client: { submitAgentCard: submitMock } as unknown as DaemonClient,
      interactive: true,
      toolName: "mcp__paseo__view_show",
      toolStatus: "completed",
      toolInput: { view: liveView },
      toolOutput: { ok: true, id: cardId, version: 1 },
    });
    expect(node).not.toBeNull();

    const { queries } = mount(node!);

    // Drill into sub-page with chart + table, then navigate back
    act(() => {
      fireEvent.click(queries.getByTestId("interactive-card-button-open-metrics"));
    });
    expect(queries.getByText("Weekly Metrics")).toBeTruthy();
    expect(queries.getByTestId("interactive-card-chart")).toBeTruthy();
    expect(queries.getByTestId("interactive-card-table")).toBeTruthy();

    act(() => {
      fireEvent.click(queries.getByTestId("interactive-card-back"));
    });
    expect(queries.getByText("Automation Controls")).toBeTruthy();

    // Flip toggle + pick choice pill + submit form
    act(() => {
      fireEvent.click(queries.getByTestId("interactive-card-toggle-autoClose"));
      fireEvent.click(queries.getByTestId("interactive-card-choice-mode-auto"));
    });
    await act(async () => {
      fireEvent.click(queries.getByTestId("interactive-card-button-submit-form"));
    });

    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0]?.[0].values).toEqual({
      supervise: "true",
      autoClose: "true",
      mode: "auto",
    });
  });

  it("renders plain fallback text without exposing raw JSON when inline block is streaming or invalid", () => {
    const { queries } = mount(
      <TestHostProvider host={READ_ONLY_HOST}>
        <InteractiveInlineCardFence
          code='{"fallback":"Safe plain text fallback","sections":[{"items":[{"type":"field","kind":"secret"}]}]}'
          complete
        />
      </TestHostProvider>,
    );

    const fallback = queries.getByTestId("interactive-card-fallback");
    expect(fallback.textContent).toBe("Safe plain text fallback");
    expect(fallback.textContent).not.toContain('"sections"');
  });

  it("renders full rich component suite, all 9 field kinds, and quiet receipts for view_update/view_get", async () => {
    const richView: InteractiveCardView = {
      title: "Full Component Showcase",
      subtitle: "All display and form components",
      fallback: "Full component showcase fallback",
      sections: [
        {
          title: "Overview",
          items: [
            {
              type: "stat_grid",
              items: [
                {
                  label: "Tasks",
                  value: "24",
                  delta: "+12%",
                  trend: "up",
                  sparkline: [12, 16, 19, 24],
                },
                { label: "Errors", value: "0", delta: "-3", trend: "down", tone: "success" },
                { label: "Latency", value: "140", unit: "ms" },
              ],
            },
            { type: "progress", label: "Build pipeline", value: 78, tone: "accent" },
            {
              type: "checklist",
              variant: "steps",
              items: [
                { label: "Protocol", status: "done" },
                { label: "Server", status: "in_progress" },
                { label: "Release", status: "pending" },
              ],
            },
            {
              type: "chart",
              chartType: "line",
              area: true,
              categories: ["Mon", "Tue", "Wed", "Thu"],
              series: [{ name: "Throughput", values: [10, 22, 18, 31] }],
            },
            {
              type: "chart",
              chartType: "donut",
              center: { label: "Total", value: "100" },
              slices: [
                { label: "A", value: 30 },
                { label: "B", value: 20 },
                { label: "C", value: 15 },
                { label: "D", value: 10 },
                { label: "E", value: 8 },
                { label: "F", value: 6 },
                { label: "G", value: 5 },
                { label: "H", value: 3 },
                { label: "I", value: 2 },
                { label: "J", value: 1 },
              ],
            },
            { type: "divider", label: "Artifacts" },
            { type: "code", language: "ts", title: "demo.ts", code: "export const ok = true;" },
            {
              type: "diff",
              filePath: "demo.ts",
              diff: "-const a = 1;\n+const a = 2;",
            },
            {
              type: "file_tree",
              nodes: [
                {
                  path: "packages/protocol/src/interactive-cards.ts",
                  kind: "file",
                  status: "added",
                },
              ],
            },
            {
              type: "grid",
              columns: 2,
              items: [
                { type: "metric", label: "CPU", value: "32%" },
                { type: "metric", label: "RAM", value: "4.2 GB" },
              ],
            },
            { type: "empty", title: "No alerts" },
            { type: "loading", label: "Syncing" },
            {
              type: "carousel",
              items: [
                { title: "Slide one", subtitle: "First card", value: "1/2" },
                { title: "Slide two", subtitle: "Second card", value: "2/2" },
              ],
            },
            { type: "link", label: "Docs", url: "https://example.com" },
          ],
        },
        {
          title: "Form Controls",
          items: [
            {
              type: "field",
              name: "dir",
              label: "Auto-approve directory",
              kind: "choice",
              value: "none",
              options: [
                { value: "none", label: "Keep prompting" },
                { value: "repo-a", label: "Repo A" },
                { value: "repo-b", label: "Repo B" },
                { value: "repo-c", label: "Repo C" },
                { value: "repo-d", label: "Repo D" },
              ],
            },
            {
              type: "field",
              name: "scopes",
              label: "Scopes",
              kind: "multichoice",
              value: "web",
              options: [
                { value: "web", label: "Web" },
                { value: "ios", label: "iOS" },
              ],
            },
            { type: "field", name: "note", label: "Note", kind: "text", placeholder: "Short note" },
            { type: "field", name: "summary", label: "Summary", kind: "multiline" },
            { type: "field", name: "budget", label: "Budget", kind: "number", value: "5" },
            { type: "field", name: "day", label: "Day", kind: "date", value: "2026-11-24" },
            { type: "field", name: "at", label: "Time", kind: "time", value: "09:30" },
            {
              type: "field",
              name: "schedule",
              label: "Schedule",
              kind: "datetime",
              value: "2026-11-24T09:30",
            },
          ],
        },
      ],
    };

    const cardId = "view_aabbccddeeff";
    applyAgentCardsSnapshot("srv-1", "ag-rich", {
      views: [
        {
          id: cardId,
          agentId: "ag-rich",
          version: 1,
          view: richView,
          createdAt: "2026-11-24T00:00:00.000Z",
          updatedAt: "2026-11-24T00:00:00.000Z",
        },
      ],
      inlineBlockKeys: [],
      actions: [],
    });

    const node = renderInteractiveToolCard({
      serverId: "srv-1",
      agentId: "ag-rich",
      client: null,
      interactive: false,
      toolName: "mcp__paseo__view_show",
      toolStatus: "completed",
      toolInput: { view: richView },
      toolOutput: { ok: true, id: cardId, version: 1 },
    });
    const { queries } = mount(node!);

    expect(queries.getByText("Full Component Showcase")).toBeTruthy();
    expect(queries.getByText("Build pipeline")).toBeTruthy();
    expect(queries.getByText("78%")).toBeTruthy();
    expect(queries.getByText("Total")).toBeTruthy();
    expect(queries.getByText("100")).toBeTruthy();
    expect(queries.getByTestId("interactive-card-field-dir")).toBeTruthy();
    expect(queries.getByTestId("interactive-card-field-scopes")).toBeTruthy();
    expect(queries.getByTestId("interactive-card-field-schedule")).toBeTruthy();

    // view_update renders as a quiet single-line receipt rather than duplicating the card
    const receipt = renderInteractiveToolCard({
      serverId: "srv-1",
      agentId: "ag-rich",
      client: null,
      interactive: false,
      toolName: "mcp__paseo__view_update",
      toolStatus: "completed",
      toolInput: { id: cardId, view: richView },
      toolOutput: { ok: true, id: cardId, version: 2 },
    });
    expect(receipt).not.toBeNull();
    const receiptMount = mount(receipt!);
    expect(receiptMount.queries.getByTestId("interactive-live-card-view_update")).toBeTruthy();
  });

  it("routes paseo://agent/... and paseo://task/... links to the MainChat drawer while keeping paseo://file/... intact", async () => {
    await page.viewport(1280, 820);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    useMainChatDrawerStore.getState().closeDrawer();
    useSessionStore.setState({
      sessions: {
        "srv-1": {
          hasHydratedAgents: true,
          serverInfo: { hostname: "DevBox" },
          agents: new Map([
            [
              "ag_12345678_worker",
              {
                id: "ag_12345678_worker",
                workspaceId: "ws-1",
                title: "Session Link Target",
                status: "running",
                cwd: "/repo/paseo-fork",
              },
            ],
          ]),
          agentDetails: new Map(),
          workspaces: new Map(),
        },
      } as unknown as ReturnType<typeof useSessionStore.getState>["sessions"],
    });
    useMainChatOverviewStore.setState({
      overviewsByKey: {
        [overviewStoreKey("srv-1", "ag-main")]: {
          plans: [],
          tasks: [
            {
              id: "task_abcdef12_demo",
              serverId: "srv-1",
              activeAgentId: "ag_12345678_worker",
              agentIds: ["ag_12345678_worker"],
              workspaceId: "ws-1",
              title: "Demo Task",
              status: "in_progress",
              cwd: "/repo/paseo-fork",
            },
          ],
          decisions: [],
          triages: [],
          receipts: [],
          reworks: [],
          nextStepSuggestions: [],
          settings: {
            title: "管家",
            style: "conservative",
            capabilities: {
              autoContinueManualErrors: true,
              autoDelegateManualQuestions: false,
              autoNudgeManualStalled: false,
            },
            stylePresets: [],
            activeStylePresetId: "builtin_conservative",
          },
          patrol: { enabled: true, intervalMs: 60_000, lastRunAt: null, lastSignalCount: 0 },
          compaction: null,
        } as unknown as MainChatOverview,
      },
    });

    const onOpenFilePath = vi.fn();
    const view: InteractiveCardView = {
      title: "Session Navigation",
      fallback: "Open linked sessions",
      sections: [
        {
          items: [
            { type: "link", label: "Jump Agent Prefix", url: "paseo://agent/srv-1/ag_12345" },
            {
              type: "button",
              label: "Jump Task Prefix",
              action: { kind: "open", id: "open-task", url: "paseo://task/task_abc" },
            },
            { type: "link", label: "Jump File", url: "paseo://file/src/index.ts" },
          ],
        },
      ],
    };

    const rawJson = JSON.stringify(view);
    const hostValue = createTestHost({
      serverId: "srv-1",
      agentId: "ag-main",
      interactive: false,
      onOpenFilePath,
    });

    const { queries } = mount(
      <MainChatShellProvider value={MAIN_CHAT_SHELL_VALUE}>
        <TestHostProvider host={hostValue}>
          <InteractiveInlineCardFence code={rawJson} />
        </TestHostProvider>
      </MainChatShellProvider>,
    );

    await act(async () => {
      fireEvent.click(queries.getByText("Jump Agent Prefix"));
    });
    expect(useMainChatDrawerStore.getState().activeTarget).toMatchObject({
      serverId: "srv-1",
      agentId: "ag_12345678_worker",
      workspaceId: "ws-1",
    });

    useMainChatDrawerStore.getState().closeDrawer();

    await act(async () => {
      fireEvent.click(queries.getByTestId("interactive-card-button-open-task"));
    });
    expect(useMainChatDrawerStore.getState().activeTarget).toMatchObject({
      serverId: "srv-1",
      agentId: "ag_12345678_worker",
      taskId: "task_abcdef12_demo",
    });

    await act(async () => {
      fireEvent.click(queries.getByText("Jump File"));
    });
    expect(onOpenFilePath).toHaveBeenCalledWith("src/index.ts");

    useMainChatDrawerStore.getState().closeDrawer();
  });
});
