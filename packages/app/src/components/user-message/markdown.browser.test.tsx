import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { UserMessage } from "@/components/message";
import { ToastProvider } from "@/contexts/toast-context";
import { createUserMessageExpansion } from "./expansion";
import { UserMessageExpansionContext } from "./expansion-context";

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("React", React);
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  container.style.width = "640px";
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function waitForMarkdownReady() {
  await act(async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (!container.querySelector('[aria-busy="true"]')) break;
    }
  });
}

function renderUserMessage(message: string) {
  const queryClient = new QueryClient();
  const expansion = createUserMessageExpansion();
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <UserMessageExpansionContext.Provider value={expansion}>
            <UserMessage itemId="msg-1" message={message} timestamp={Date.now()} />
          </UserMessageExpansionContext.Provider>
        </ToastProvider>
      </QueryClientProvider>,
    );
  });
}

describe("UserMessage Markdown rendering", () => {
  it("renders Markdown elements inside the user bubble with chat-find marker intact", async () => {
    renderUserMessage(
      ["# Plan", "", "Use **bold** and `code`.", "", "- first item", "- second item"].join("\n"),
    );
    await waitForMarkdownReady();

    const textRoot = container.querySelector('[data-message-text="true"]');
    expect(textRoot).not.toBeNull();
    expect(textRoot?.querySelector("h1")?.textContent).toContain("Plan");
    expect(textRoot?.querySelector("strong")?.textContent).toBe("bold");
    expect(textRoot?.querySelector("code")?.textContent).toBe("code");
    expect(textRoot?.querySelectorAll("li").length).toBe(2);
  });

  it("keeps short user bubbles fitted to their text width instead of stretching full width", async () => {
    renderUserMessage("hi");
    await waitForMarkdownReady();

    const textRoot = container.querySelector('[data-message-text="true"]') as HTMLElement;
    expect(textRoot.getBoundingClientRect().width).toBeLessThan(200);
  });

  it("collapses long Markdown user messages inside MessagePreview with Show more toggle", async () => {
    const longMarkdown = Array.from(
      { length: 30 },
      (_, index) => `- **Step ${index + 1}**: verify \`module_${index + 1}.ts\``,
    ).join("\n");
    renderUserMessage(longMarkdown);
    await waitForMarkdownReady();

    expect(within(container).getByRole("button", { name: "Show more" })).toBeTruthy();
  });
});
