import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { ToastApi } from "@/components/toast-host";
import { ToastApiProvider } from "@/contexts/toast-context";
import { i18n } from "@/i18n/i18next";
import { useMainChatDrawerStore } from "@/main-chat/drawer-store";
import { MainChatShellProvider } from "@/main-chat/shell-context";
import { useSessionStore } from "@/stores/session-store";
import { WEB_RENDERERS } from "./renderers.web";

const Link = WEB_RENDERERS.link;
const LINK_TEXT = "src/index.ts";
const SESSION_LINK_SHELL_VALUE = {
  inMainChatShell: true,
  originRoute: "/main",
  originTitle: "Assistant",
};
const VALID_SESSION_LINK_META = {
  url: "paseo://agent/srv_1/ag_12345678",
  sourceType: "markdown" as const,
};
const MISSING_SESSION_LINK_META = {
  url: "paseo://agent/srv_1/ag_missing_999999",
  sourceType: "markdown" as const,
};
const sessionLinkToastError = vi.fn();
const sessionLinkToastApi: ToastApi = {
  show: vi.fn(() => () => {}),
  copied: vi.fn(),
  error: sessionLinkToastError,
};
const sessionLinkDefaultClick = vi.fn();
const VALID_SESSION_ANCHOR_PROPS = {
  href: "paseo://agent/srv_1/ag_12345678",
  onClick: sessionLinkDefaultClick,
};
const MISSING_SESSION_ANCHOR_PROPS = {
  href: "paseo://agent/srv_1/ag_missing_999999",
  onClick: sessionLinkDefaultClick,
};

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function anchorPropsFor(url: string) {
  return { href: url };
}

function renderAnchor(link: { url: string; sourceType?: "markdown" | "text" | "inline-code" }) {
  if (!Link) {
    throw new Error("Expected a web link renderer");
  }
  const anchorProps = anchorPropsFor(link.url);
  const client = new QueryClient();
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <Link link={link} anchorProps={anchorProps}>
          {LINK_TEXT}
        </Link>
      </QueryClientProvider>,
    ),
  );
  const anchor = container.querySelector("a");
  if (!anchor) {
    throw new Error("Expected a rendered link");
  }
  return anchor;
}

it("marks a link it recognized from a path for selection copy", () => {
  const anchor = renderAnchor({ url: LINK_TEXT, sourceType: "text" });
  expect(anchor.getAttribute("href")).toBe(LINK_TEXT);
  expect(anchor.getAttribute("data-paseo-markdown-recognized-link")).toBe("true");
});

it("leaves an authored link wrapped", () => {
  const anchor = renderAnchor({ url: "https://example.test/doc", sourceType: "markdown" });
  expect(anchor.hasAttribute("data-paseo-markdown-recognized-link")).toBe(false);
});

it("renders paseo:// session links with restrained styling, in-app href, modifier pass-through, and drawer/toast behavior", async () => {
  await page.viewport(1280, 800);
  if (!Link) {
    throw new Error("Expected a web link renderer");
  }
  useMainChatDrawerStore.getState().closeDrawer();
  useSessionStore.setState({
    sessions: {
      srv_1: {
        serverId: "srv_1",
        hasHydratedAgents: true,
        serverInfo: { hostname: "DevBox" },
        agents: new Map([
          [
            "ag_12345678_session",
            {
              id: "ag_12345678_session",
              serverId: "srv_1",
              workspaceId: "ws_repo",
              title: "Refactor Session Links",
              cwd: "/repo/paseo-fork",
              status: "running",
              requiresAttention: false,
              attentionReason: null,
              labels: {},
            },
          ],
        ]),
        agentDetails: new Map(),
        workspaces: new Map([
          [
            "ws_repo",
            {
              id: "ws_repo",
              projectDisplayName: "paseo-fork",
              workspaceDirectory: "/repo/paseo-fork",
            },
          ],
        ]),
      },
    } as unknown as ReturnType<typeof useSessionStore.getState>["sessions"],
  });

  sessionLinkToastError.mockClear();
  sessionLinkDefaultClick.mockClear();
  const client = new QueryClient();

  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <ToastApiProvider api={sessionLinkToastApi}>
          <MainChatShellProvider value={SESSION_LINK_SHELL_VALUE}>
            <div>
              <Link link={VALID_SESSION_LINK_META} anchorProps={VALID_SESSION_ANCHOR_PROPS}>
                Refactor Session Links
              </Link>
              <Link link={MISSING_SESSION_LINK_META} anchorProps={MISSING_SESSION_ANCHOR_PROPS}>
                Missing Session
              </Link>
            </div>
          </MainChatShellProvider>
        </ToastApiProvider>
      </QueryClientProvider>,
    ),
  );

  const links = container.querySelectorAll<HTMLAnchorElement>('a[data-session-link="true"]');
  expect(links).toHaveLength(2);

  const validLink = links[0]!;
  const missingLink = links[1]!;

  // Zero extra inline icons/badges — pure inline text content
  expect(validLink.childElementCount).toBe(0);
  expect(validLink.textContent).toBe("Refactor Session Links");
  expect(validLink.getAttribute("data-session-link-status")).toBe("prefix");

  // Never exposes paseo:// to browser href; valid link maps to real in-app route
  expect(validLink.getAttribute("href")).not.toContain("paseo://");
  expect(validLink.getAttribute("href")).toContain("/h/srv_1/workspace/ws_repo");
  expect(missingLink.getAttribute("href")).not.toContain("paseo://");

  // Restrained styling: underline always on, 3px offset, 38% alpha underline color, solid on hover
  const restStyle = window.getComputedStyle(validLink);
  expect(restStyle.textDecorationLine).toContain("underline");
  expect(restStyle.textUnderlineOffset).toBe("3px");
  expect(validLink.style.textDecorationColor).toContain("0.38");

  act(() => {
    validLink.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    validLink.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
  });
  expect(validLink.style.textDecorationColor).not.toContain("0.38");

  // Cmd/Ctrl modifier click preserves browser default (does NOT preventDefault or open drawer).
  // Capture defaultPrevented at the container bubble phase and cancel only after verifying so
  // the Vitest headless iframe itself does not navigate away from the runner URL.
  let modifierPreventedByLink: boolean | null = null;
  const stopIframeNav = (event: MouseEvent) => {
    modifierPreventedByLink = event.defaultPrevented;
    event.preventDefault();
  };
  container.addEventListener("click", stopIframeNav);
  const modifierEvent = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    metaKey: true,
  });
  act(() => {
    validLink.dispatchEvent(modifierEvent);
  });
  container.removeEventListener("click", stopIframeNav);
  expect(modifierPreventedByLink).toBe(false);
  expect(useMainChatDrawerStore.getState().activeTarget).toBeNull();
  expect(sessionLinkDefaultClick).not.toHaveBeenCalled();

  // Plain left click opens TaskPanelDrawer on wide screens and prevents default navigation
  const plainEvent = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    validLink.dispatchEvent(plainEvent);
  });
  expect(plainEvent.defaultPrevented).toBe(true);
  expect(useMainChatDrawerStore.getState().activeTarget?.agentId).toBe("ag_12345678_session");

  // Missing session link prevents default (never triggers protocol prompt) and shows error toast
  const missingEvent = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    missingLink.dispatchEvent(missingEvent);
  });
  expect(missingEvent.defaultPrevented).toBe(true);
  expect(sessionLinkToastError).toHaveBeenCalledTimes(1);
});
