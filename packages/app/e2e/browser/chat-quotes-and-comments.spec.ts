import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import {
  MAIN_CHAT_FORMER_ROLE_VALUE,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
} from "@getpaseo/protocol/main-chat";
import { expect, test } from "../support/fixtures";
import { awaitAssistantMessage } from "../support/helpers/agent-stream";
import { chatOutlineRail, expectChatOutlinePrompts } from "../support/helpers/chat-outline";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";

const SCREENSHOT_DIR = "/tmp/main-chat-quotes-screenshots";
const WIDE_VIEWPORT = { width: 1440, height: 900 };
const NARROW_VIEWPORT = { width: 768, height: 900 };

const RICH_ASSISTANT_RESPONSE = [
  "Here is the structured architecture summary for message quotes and inline comments:",
  "",
  "- **Multi-quote stack**: supports queueing whole-message quotes and selection comments together above the composer.",
  "- **IME safe editing**: Chinese composition `Enter` confirms candidate words without prematurely submitting the annotation.",
  "- **Selection copy intact**: highlighting assistant text keeps `assistant-selection-copy` rich markdown copy untouched.",
].join("\n");

function composerTextbox(page: Page) {
  return page.locator("textarea:visible").last();
}

async function selectSubstringInAssistantMessage(page: Page, targetText: string): Promise<void> {
  const selected = await page.evaluate((needle) => {
    const containers = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="assistant-message"]'),
    );
    for (let i = containers.length - 1; i >= 0; i -= 1) {
      const container = containers[i]!;
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const value = node.textContent ?? "";
        const offset = value.indexOf(needle);
        if (offset !== -1) {
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + needle.length);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          document.dispatchEvent(new Event("selectionchange"));
          document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          return selection?.toString() ?? "";
        }
        node = walker.nextNode();
      }
    }
    return "";
  }, targetText);

  expect(selected).toBe(targetText);
}

async function assertNoHorizontalOverflowAndAlignedTray(page: Page): Promise<void> {
  const layout = await page.evaluate(() => {
    const docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const tray = document.querySelector<HTMLElement>('[data-testid="composer-quote-tray"]');
    const trayRect = tray?.getBoundingClientRect() ?? null;
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="composer-quote-item"], [data-testid="composer-comment-item"]',
      ),
    ).map((el) => el.getBoundingClientRect());
    const popover = document.querySelector<HTMLElement>('[data-testid="chat-selection-popover"]');
    const popoverRect = popover?.getBoundingClientRect() ?? null;

    return {
      viewportWidth: window.innerWidth,
      docOverflow,
      trayRect: trayRect
        ? {
            left: trayRect.left,
            right: trayRect.right,
            height: trayRect.height,
          }
        : null,
      cards: cards.map((r) => ({ left: r.left, right: r.right })),
      popoverRect: popoverRect
        ? {
            left: popoverRect.left,
            right: popoverRect.right,
            top: popoverRect.top,
            bottom: popoverRect.bottom,
          }
        : null,
    };
  });

  expect(layout.docOverflow).toBeLessThanOrEqual(2);
  if (layout.trayRect) {
    expect(layout.trayRect.height).toBeLessThanOrEqual(204);
    expect(layout.trayRect.left).toBeGreaterThanOrEqual(0);
    expect(layout.trayRect.right).toBeLessThanOrEqual(layout.viewportWidth + 1);
    for (const card of layout.cards) {
      expect(card.left).toBeGreaterThanOrEqual(layout.trayRect.left - 2);
      expect(card.right).toBeLessThanOrEqual(layout.trayRect.right + 2);
    }
  }
  if (layout.popoverRect) {
    expect(layout.popoverRect.left).toBeGreaterThanOrEqual(0);
    expect(layout.popoverRect.right).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.popoverRect.top).toBeGreaterThanOrEqual(0);
  }
}

test.describe("Chat quotes, inline selection comments, main-chat fork hiding & outline filtering", () => {
  test.describe.configure({ timeout: 180_000 });

  test("supports multi-quote stack, selection comment with IME, intact selection copy, draft isolation/persistence, and structured rendering", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize(WIDE_VIEWPORT);

    const sessionA = await seedMockAgentWorkspace({
      repoPrefix: "chat-quotes-a-",
      title: "Quotes Workspace A",
      featureValues: {
        mockAssistantResponse: RICH_ASSISTANT_RESPONSE,
      },
    });
    const sessionB = await seedMockAgentWorkspace({
      repoPrefix: "chat-quotes-b-",
      title: "Quotes Workspace B",
      featureValues: {
        mockAssistantResponse: "Workspace B isolated assistant reply for draft isolation check.",
      },
    });

    try {
      await sessionA.client.sendAgentMessage(
        sessionA.agentId,
        "First user message to quote in workspace A.",
      );
      await sessionA.client.waitForFinish(sessionA.agentId, 30_000);

      await sessionA.client.sendAgentMessage(
        sessionA.agentId,
        "Second user message to build a multi-quote stack.",
      );
      await sessionA.client.waitForFinish(sessionA.agentId, 30_000);

      await sessionB.client.sendAgentMessage(
        sessionB.agentId,
        "Message inside isolated workspace B.",
      );
      await sessionB.client.waitForFinish(sessionB.agentId, 30_000);

      await openAgentRoute(page, sessionA);
      await awaitAssistantMessage(page);

      // Regular workspace keeps Fork menu and adds Quote button on assistant turns.
      await expect(page.getByTestId("assistant-fork-menu-trigger").last()).toBeVisible();
      await expect(page.getByTestId("assistant-message-quote-button").last()).toBeVisible();

      // 1. Quote assistant turn.
      await page.getByTestId("assistant-message-quote-button").last().click();
      await expect(page.getByTestId("composer-quote-tray")).toBeVisible();
      await expect(page.getByTestId("composer-quote-item")).toHaveCount(1);

      // 2. Hover user message bubble and quote it to stack a second whole-message quote.
      const firstUserMsg = page
        .getByTestId("user-message")
        .filter({ hasText: "First user message to quote in workspace A." })
        .first();
      await firstUserMsg.getByText("First user message to quote in workspace A.").hover();
      await firstUserMsg.getByTestId("user-message-quote-button").click();
      await expect(page.getByTestId("composer-quote-item")).toHaveCount(2);

      // 3. Highlight text in assistant message -> popover appears AND native selection copy remains intact.
      const copyTarget = "Multi-quote stack";
      await selectSubstringInAssistantMessage(page, copyTarget);
      await expect(page.getByTestId("chat-selection-popover")).toBeVisible();
      await expect(page.getByTestId("selection-popover-comment")).toBeVisible();
      await expect(page.getByTestId("selection-popover-quote")).toBeVisible();

      // Trigger browser copy event without clicking popover: assistant-selection-copy must still copy the selected markdown.
      const copiedText = await page.evaluate(() => {
        const dt = new DataTransfer();
        const event = new ClipboardEvent("copy", {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        });
        const activeTarget = window.getSelection()?.anchorNode?.parentElement ?? document.body;
        activeTarget.dispatchEvent(event);
        return dt.getData("text/plain") || window.getSelection()?.toString() || "";
      });
      expect(copiedText).toContain("Multi-quote stack");

      // 4. Click "Comment" on selection popover -> inline comment card opens & respects Chinese IME composition.
      await page.getByTestId("selection-popover-comment").click();
      await expect(page.getByTestId("composer-comment-item")).toHaveCount(1);
      const commentInput = page.getByTestId("composer-comment-input-1");
      await expect(commentInput).toBeFocused();

      // Simulate CJK IME composition Enter: must NOT commit early.
      await commentInput.evaluate((el) => {
        el.dispatchEvent(
          new CompositionEvent("compositionstart", { bubbles: true, data: "zhongwen" }),
        );
        el.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
            isComposing: true,
          }),
        );
      });
      await expect(commentInput).toBeVisible();

      await commentInput.evaluate((el) => {
        el.dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true, data: "中文批注" }),
        );
      });
      await commentInput.fill("请确认这段引用逻辑在窄屏下不会溢出");
      await commentInput.press("Enter");
      await expect(page.getByTestId("composer-comment-preview-1")).toContainText(
        "请确认这段引用逻辑在窄屏下不会溢出",
      );

      // 5. Add two more selection quotes to verify bounded height + scrollability + no overflow.
      await selectSubstringInAssistantMessage(page, "IME safe editing");
      await page.getByTestId("selection-popover-quote").click();
      await selectSubstringInAssistantMessage(page, "Selection copy intact");
      await page.getByTestId("selection-popover-quote").click();

      await expect(page.getByTestId("composer-quote-item")).toHaveCount(4);
      await assertNoHorizontalOverflowAndAlignedTray(page);

      const scrollMetrics = await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>(
          '[data-testid="composer-quote-tray-scroll"]',
        );
        return scroller
          ? {
              clientHeight: scroller.clientHeight,
              scrollHeight: scroller.scrollHeight,
            }
          : null;
      });
      expect(scrollMetrics).not.toBeNull();
      expect(scrollMetrics!.clientHeight).toBeLessThanOrEqual(200);
      expect(scrollMetrics!.scrollHeight).toBeGreaterThan(scrollMetrics!.clientHeight);

      // 6. Remove a single item from the stack.
      const removeButtons = page.locator('[data-testid^="composer-quote-remove-"]');
      await removeButtons.first().click();
      await expect(page.getByTestId("composer-quote-item")).toHaveCount(3);
      await expect(page.getByTestId("composer-comment-item")).toHaveCount(1);

      // 7. Cross-draft isolation + persistence across reload.
      await openAgentRoute(page, sessionB);
      await awaitAssistantMessage(page);
      await expect(page.getByTestId("composer-quote-tray")).toHaveCount(0);

      await page.getByTestId("assistant-message-quote-button").last().click();
      await expect(page.getByTestId("composer-quote-item")).toHaveCount(1);

      // Navigate back to session A and reload page: session A's quote+comment stack must persist independently.
      await openAgentRoute(page, sessionA);
      await page.reload({ waitUntil: "domcontentloaded" });
      await awaitAssistantMessage(page);
      await expect(page.getByTestId("composer-quote-tray")).toBeVisible();
      await expect(page.getByTestId("composer-quote-item")).toHaveCount(3);
      await expect(page.getByTestId("composer-comment-item")).toHaveCount(1);

      // 8. Submit composed message with quotes + comment -> tray clears and sent bubble renders structured blocks.
      const input = composerTextbox(page);
      await input.fill("综合以上引用与划词批注，请给出一版重构方案。");
      await input.press("Enter");

      await expect(page.getByTestId("composer-quote-tray")).toHaveCount(0);
      await sessionA.client.waitForFinish(sessionA.agentId, 30_000);

      const latestUserMessage = page.getByTestId("user-message").last();
      await expect(latestUserMessage.getByTestId("sent-quote-stack")).toBeVisible();
      await expect(latestUserMessage.getByTestId("sent-quote-block")).toHaveCount(3);
      await expect(latestUserMessage.getByTestId("sent-comment-block")).toHaveCount(1);
      await expect(latestUserMessage).toContainText("请确认这段引用逻辑在窄屏下不会溢出");
      await expect(latestUserMessage).toContainText("综合以上引用与划词批注，请给出一版重构方案。");
    } finally {
      await Promise.allSettled([sessionA.cleanup(), sessionB.cleanup()]);
    }
  });

  test("hides Fork in Main Chat, filters <paseo-system> from ChatOutline, and captures 4 wide/narrow light/dark screenshots", async ({
    page,
  }) => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const workspace = await seedWorkspace({
      repoPrefix: "main-chat-quotes-screenshots-",
    });

    let mainAgentId: string | null = null;

    try {
      const mainAgent = await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "主对话 · 引用与划词评论验收",
        modeId: "load-test",
        model: "e2e-fast-stream",
        labels: {
          [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE,
        },
        featureValues: {
          mockAssistantResponse: [
            "已梳理本次消息引用回复与划词评论的核心改造点：",
            "",
            "1. **整条引用回复**：所有用户与助手消息底部均提供引用按钮，可叠加挂载多条引用栈并跨草稿隔离持久化。",
            "2. **桌面端划词评论**：选中消息正文后弹出轻量「评论 / 引用」浮条，批注输入框完整兼容中文输入法组合态，同时不干扰选区复制。",
            "3. **主对话体验净化**：主对话中自动隐藏消息底部 Fork 按钮，且右侧 ChatOutline 自动过滤 `<paseo-system>` 后台巡检/保活轮次。",
          ].join("\n"),
        },
      });
      mainAgentId = mainAgent.id;

      // Inject a <paseo-system> patrol turn plus two genuine human turns.
      await workspace.client.sendAgentMessage(
        mainAgent.id,
        '<paseo-system kind="main-chat-background" bg-kind="patrol">\n📋 督办 · 主动巡检唤醒：\n后台保活巡检测试，不应进入 ChatOutline 大纲。\n</paseo-system>',
      );
      await workspace.client.waitForFinish(mainAgent.id, 30_000);

      await workspace.client.sendAgentMessage(
        mainAgent.id,
        "请总结一下主对话里消息引用回复与划词评论的完整设计方案。",
      );
      await workspace.client.waitForFinish(mainAgent.id, 30_000);

      await workspace.client.sendAgentMessage(
        mainAgent.id,
        "另外请确认主对话底部 Fork 按钮隐藏与右侧大纲过滤后台巡检轮次的行为。",
      );
      await workspace.client.waitForFinish(mainAgent.id, 30_000);

      const applyThemeAndOpen = async (
        theme: "light" | "dark",
        viewport: { width: number; height: number },
      ) => {
        await page.setViewportSize(viewport);
        await page.addInitScript(
          ({ selectedTheme }) => {
            localStorage.setItem(
              "@paseo:app-settings",
              JSON.stringify({
                theme: selectedTheme,
                language: "zh-CN",
                chatOutlineEnabled: true,
              }),
            );
          },
          { selectedTheme: theme },
        );
        await openAgentRoute(page, {
          workspaceId: workspace.workspaceId,
          agentId: mainAgent.id,
        });
        await page.evaluate((selectedTheme) => {
          localStorage.setItem(
            "@paseo:app-settings",
            JSON.stringify({
              theme: selectedTheme,
              language: "zh-CN",
              chatOutlineEnabled: true,
            }),
          );
        }, theme);
        await page.reload({ waitUntil: "domcontentloaded" });
        await awaitAssistantMessage(page);
      };

      // --- Screenshot 1: Desktop Wide (1440x900) Light Theme ---
      await applyThemeAndOpen("light", WIDE_VIEWPORT);

      // Main Chat MUST hide Fork buttons while showing Quote buttons.
      await expect(page.getByTestId("assistant-fork-menu-trigger")).toHaveCount(0);
      await expect(page.getByTestId("assistant-message-quote-button").last()).toBeVisible();

      // ChatOutline MUST filter out the <paseo-system> patrol turn (only 2 real human turns shown).
      await expectChatOutlinePrompts(page, 2);
      const railText = await chatOutlineRail(page).innerText();
      expect(railText).not.toContain("paseo-system");

      // Send one composed message containing 1 quote + 1 selection comment so sent blocks appear in stream.
      await page.getByTestId("assistant-message-quote-button").last().click();
      await selectSubstringInAssistantMessage(page, "桌面端划词评论");
      await page.getByTestId("selection-popover-comment").click();
      const firstCommentInput = page.getByTestId("composer-comment-input-1");
      await firstCommentInput.fill("确认亮暗主题下浮条对比度与边界避让均正常。");
      await firstCommentInput.press("Enter");

      const composer = composerTextbox(page);
      await composer.fill("按这个方案落地，并补充宽窄屏与亮暗主题目视截图。");
      await composer.press("Enter");
      await workspace.client.waitForFinish(mainAgent.id, 30_000);
      await expect(page.getByTestId("sent-quote-stack").last()).toBeVisible();
      await expect(page.getByTestId("sent-comment-block").last()).toBeVisible();

      // Now stage a live multi-item stack above the composer (1 whole quote + 1 comment) for visual inspection.
      await page.getByTestId("assistant-message-quote-button").last().click();
      await selectSubstringInAssistantMessage(page, "主对话体验净化");
      await page.getByTestId("selection-popover-comment").click();
      const stagedCommentInput = page.getByTestId("composer-comment-input-1");
      await stagedCommentInput.fill("已验证主对话无 Fork 按钮，且右侧大纲自动过滤了后台巡检轮。");
      await stagedCommentInput.press("Enter");
      await composer.fill("继续跟进这一步的验收细节");
      await assertNoHorizontalOverflowAndAlignedTray(page);

      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "01-desktop-wide-light.png"),
      });

      // --- Screenshot 2: Desktop Wide (1440x900) Dark Theme with Active Selection Popover ---
      await applyThemeAndOpen("dark", WIDE_VIEWPORT);
      await expect(page.getByTestId("assistant-fork-menu-trigger")).toHaveCount(0);
      await expect(page.getByTestId("composer-quote-tray")).toBeVisible();
      await selectSubstringInAssistantMessage(page, "整条引用回复");
      await expect(page.getByTestId("chat-selection-popover")).toBeVisible();
      await assertNoHorizontalOverflowAndAlignedTray(page);

      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "02-desktop-wide-dark.png"),
      });

      // --- Screenshot 3: Desktop Narrow (768x900) Light Theme with Scrollable Stack ---
      await applyThemeAndOpen("light", NARROW_VIEWPORT);
      await expect(page.getByTestId("assistant-fork-menu-trigger")).toHaveCount(0);
      // Add extra quotes so bounded tray scroll is demonstrated cleanly on narrow viewport.
      await selectSubstringInAssistantMessage(page, "跨草稿隔离持久化");
      await page.getByTestId("selection-popover-quote").click();
      await selectSubstringInAssistantMessage(page, "不干扰选区复制");
      await page.getByTestId("selection-popover-quote").click();
      await expect(page.getByTestId("composer-quote-tray")).toBeVisible();
      await assertNoHorizontalOverflowAndAlignedTray(page);

      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "03-desktop-narrow-light.png"),
      });

      // --- Screenshot 4: Desktop Narrow (768x900) Dark Theme ---
      await applyThemeAndOpen("dark", NARROW_VIEWPORT);
      await expect(page.getByTestId("assistant-fork-menu-trigger")).toHaveCount(0);
      await expect(page.getByTestId("composer-quote-tray")).toBeVisible();
      await expect(page.getByTestId("sent-quote-stack").last()).toBeVisible();
      await assertNoHorizontalOverflowAndAlignedTray(page);

      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "04-desktop-narrow-dark.png"),
      });
    } finally {
      if (mainAgentId) {
        const updatableClient = workspace.client as unknown as {
          updateAgent: (
            agentId: string,
            updates: { name?: string; labels?: Record<string, string> },
          ) => Promise<void>;
        };
        await updatableClient
          .updateAgent(mainAgentId, {
            labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_FORMER_ROLE_VALUE },
          })
          .catch(() => undefined);
        await workspace.client.archiveAgent(mainAgentId).catch(() => undefined);
      }
      await workspace.cleanup();
    }
  });
});
