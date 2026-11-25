import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnrichedMarkdownText } from "react-native-enriched-markdown";
import { afterEach, beforeEach, expect, it } from "vitest";
import { prepareMarkdownSource } from "./source";

const TEST_MD4C_FLAGS = { latexMath: false, hardSoftBreaks: true, admonitions: true };

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("renders <br> inside GFM table cells as real <br> elements without splitting rows", async () => {
  const source = [
    "| Item | Details | Code |",
    "| --- | --- | --- |",
    "| Row 1 | **中文：**<br>1. First<br>2. Second | `<br>` |",
  ].join("\n");
  const prepared = prepareMarkdownSource(source);
  act(() => {
    root.render(
      <EnrichedMarkdownText
        markdown={prepared.render()}
        flavor="github"
        md4cFlags={TEST_MD4C_FLAGS}
        linkRecognition={prepared.linkRecognition}
      />,
    );
  });
  await expect.poll(() => container.querySelectorAll("table").length).toBe(1);
  const bodyRows = container.querySelectorAll("tbody tr");
  expect(bodyRows).toHaveLength(1);
  const cells = bodyRows[0]!.querySelectorAll("td");
  expect(cells).toHaveLength(3);
  expect(cells[1]!.querySelectorAll("br")).toHaveLength(2);
  expect(cells[1]!.querySelector("strong")?.textContent).toBe("中文：");
  expect(cells[1]!.textContent).toBe("中文：1. First2. Second");
  expect(cells[2]!.querySelectorAll("br")).toHaveLength(0);
  expect(cells[2]!.querySelector("code")?.textContent).toBe("<br>");
});
