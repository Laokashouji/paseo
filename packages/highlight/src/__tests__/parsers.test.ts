import { describe, it, expect } from "vitest";
import { highlightCode } from "../highlighter.js";
import {
  isLanguageSupported,
  getSupportedExtensions,
  getParserForFile,
  getLanguageForFile,
} from "../parsers.js";

describe("isLanguageSupported", () => {
  it("returns true for supported file extensions", () => {
    expect(isLanguageSupported("test.js")).toBe(true);
    expect(isLanguageSupported("test.ts")).toBe(true);
    expect(isLanguageSupported("test.tsx")).toBe(true);
    expect(isLanguageSupported("test.py")).toBe(true);
    expect(isLanguageSupported("test.go")).toBe(true);
    expect(isLanguageSupported("test.rs")).toBe(true);
    expect(isLanguageSupported("test.json")).toBe(true);
    expect(isLanguageSupported("test.css")).toBe(true);
    expect(isLanguageSupported("test.html")).toBe(true);
    expect(isLanguageSupported("test.java")).toBe(true);
    expect(isLanguageSupported("test.swift")).toBe(true);
    expect(isLanguageSupported("test.dart")).toBe(true);
    expect(isLanguageSupported("test.cs")).toBe(true);
    expect(isLanguageSupported("test.nix")).toBe(true);
    expect(isLanguageSupported("main.tf")).toBe(true);
    expect(isLanguageSupported("prod.tfvars")).toBe(true);
    expect(isLanguageSupported("terragrunt.hcl")).toBe(true);
    expect(isLanguageSupported("test.ex")).toBe(true);
    expect(isLanguageSupported("Counter.svelte")).toBe(true);
    expect(isLanguageSupported("Page.astro")).toBe(true);
    expect(isLanguageSupported("App.vue")).toBe(true);
  });

  it("returns false for unsupported file extensions", () => {
    expect(isLanguageSupported("test.xyz")).toBe(false);
    expect(isLanguageSupported("test.txt")).toBe(false);
    expect(isLanguageSupported("test.csv")).toBe(false);
  });

  it("returns false for files without extensions", () => {
    expect(isLanguageSupported("Makefile")).toBe(false);
    expect(isLanguageSupported("src/ts")).toBe(false);
    expect(isLanguageSupported("bin/bash")).toBe(false);
  });

  it("handles nested paths", () => {
    expect(isLanguageSupported("src/utils/test.ts")).toBe(true);
    expect(isLanguageSupported("deep/nested/path/file.py")).toBe(true);
  });
});

describe("getSupportedExtensions", () => {
  it("returns an array of extension strings", () => {
    const extensions = getSupportedExtensions();

    expect(Array.isArray(extensions)).toBe(true);
    expect(extensions.length).toBeGreaterThan(0);
  });

  it("includes common extensions", () => {
    const extensions = getSupportedExtensions();

    expect(extensions).toContain("js");
    expect(extensions).toContain("ts");
    expect(extensions).toContain("tsx");
    expect(extensions).toContain("py");
    expect(extensions).toContain("go");
    expect(extensions).toContain("rs");
    expect(extensions).toContain("swift");
    expect(extensions).toContain("dart");
    expect(extensions).toContain("cs");
    expect(extensions).toContain("nix");
    expect(extensions).toContain("tf");
    expect(extensions).toContain("tfvars");
    expect(extensions).toContain("hcl");
    expect(extensions).toContain("json");
    expect(extensions).toContain("svelte");
    expect(extensions).toContain("astro");
    expect(extensions).toContain("vue");
  });
});

describe("getParserForFile", () => {
  it("projects the parser retained by the editor language registry", () => {
    for (const extension of getSupportedExtensions()) {
      const filename = `source.${extension}`;
      expect(getParserForFile(filename)).toBe(getLanguageForFile(filename)?.parser);
    }
  });

  it("returns a parser for supported files", () => {
    expect(getParserForFile("test.js")).not.toBeNull();
    expect(getParserForFile("test.py")).not.toBeNull();
  });

  it("returns null for unsupported files", () => {
    expect(getParserForFile("test.xyz")).toBeNull();
  });

  it("returns null for files without extension", () => {
    expect(getParserForFile("noext")).toBeNull();
  });

  it("is case-insensitive for extensions", () => {
    expect(getParserForFile("test.JS")).not.toBeNull();
    expect(getParserForFile("test.Py")).not.toBeNull();
  });

  it("parses GFM constructs and nested fenced code languages in Markdown", () => {
    const parser = getParserForFile("prompt.md");
    expect(parser).not.toBeNull();
    const doc = [
      "~~strike~~",
      "- [x] task",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "```typescript",
      "const value = 42;",
      "```",
    ].join("\n");
    const tree = parser!.parse(doc);
    const nodeNames = new Set<string>();
    tree.iterate({
      enter: (node) => {
        nodeNames.add(node.name);
      },
    });
    expect(nodeNames.has("Strikethrough")).toBe(true);
    expect(nodeNames.has("TaskMarker")).toBe(true);
    expect(nodeNames.has("Table")).toBe(true);
    expect(nodeNames.has("FencedCode")).toBe(true);

    const highlighted = highlightCode("```typescript\nconst value = 42;\n```", "prompt.md");
    expect(highlighted[1]).toEqual(
      expect.arrayContaining([
        { text: "const", style: "keyword" },
        { text: "value", style: "definition" },
        { text: "42", style: "number" },
      ]),
    );
  });
});
