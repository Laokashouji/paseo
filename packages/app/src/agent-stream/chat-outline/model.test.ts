import { describe, expect, it } from "vitest";
import {
  createActivePromptPublisher,
  filterChatOutlinePrompts,
  isHiddenSystemOutlinePromptPreview,
  shouldAcceptPromptIndexEpoch,
  promptTickMagnification,
  resolveActivePromptSeq,
  OUTLINE_MAGNIFY_RADIUS,
  type ChatOutlinePrompt,
} from "./model";

describe("chat outline prompt index epoch", () => {
  it("accepts only the authoritative timeline epoch", () => {
    expect(shouldAcceptPromptIndexEpoch("epoch-2", "epoch-2")).toBe(true);
    expect(shouldAcceptPromptIndexEpoch("epoch-2", "epoch-1")).toBe(false);
  });
});

function prompt(seq: number): ChatOutlinePrompt {
  return { seq, timestamp: new Date(seq).toISOString(), preview: `prompt ${seq}` };
}

describe("promptTickMagnification", () => {
  it("peaks under the pointer and decays to nothing at the radius", () => {
    expect(promptTickMagnification(0)).toBe(1);
    expect(promptTickMagnification(OUTLINE_MAGNIFY_RADIUS)).toBe(0);
    expect(promptTickMagnification(OUTLINE_MAGNIFY_RADIUS + 10)).toBe(0);
  });

  it("falls off monotonically and symmetrically around the pointer", () => {
    const above = [0, 1, 2, 3].map((distance) => promptTickMagnification(distance));
    const below = [0, -1, -2, -3].map((distance) => promptTickMagnification(distance));

    expect(above).toEqual(below);
    expect(above).toEqual([...above].sort((left, right) => right - left));
  });
});

describe("resolveActivePromptSeq", () => {
  const prompts = [prompt(2), prompt(9), prompt(20)];

  it("marks the prompt whose turn the reading position sits in", () => {
    expect(resolveActivePromptSeq(prompts, 9)).toBe(9);
    expect(resolveActivePromptSeq(prompts, 14)).toBe(9);
    expect(resolveActivePromptSeq(prompts, 20)).toBe(20);
    expect(resolveActivePromptSeq(prompts, 99)).toBe(20);
  });

  it("marks nothing above the first prompt or without a reading position", () => {
    expect(resolveActivePromptSeq(prompts, 1)).toBeNull();
    expect(resolveActivePromptSeq(prompts, null)).toBeNull();
    expect(resolveActivePromptSeq([], 42)).toBeNull();
  });
});

describe("createActivePromptPublisher", () => {
  it("notifies subscribers only when the active prompt changes", () => {
    const publisher = createActivePromptPublisher();
    let notifications = 0;
    const unsubscribe = publisher.subscribe(() => {
      notifications += 1;
    });

    publisher.publish(9);
    publisher.publish(9);
    publisher.publish(20);
    unsubscribe();
    publisher.publish(null);

    expect(notifications).toBe(2);
    expect(publisher.getActiveSeq()).toBeNull();
  });
});

describe("filterChatOutlinePrompts", () => {
  it("filters <paseo-system> envelopes, legacy background headers, and hidden seqs", () => {
    const prompts: ChatOutlinePrompt[] = [
      {
        seq: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        preview: '<paseo-system kind="main-chat-background"> patrol',
      },
      {
        seq: 2,
        timestamp: "2026-01-01T00:00:01.000Z",
        preview: "<paseo-system> keepalive",
      },
      {
        seq: 3,
        timestamp: "2026-01-01T00:00:02.000Z",
        preview: "📋 督办 · 主动巡检唤醒：后台巡检",
      },
      {
        seq: 4,
        timestamp: "2026-01-01T00:00:03.000Z",
        preview: "Human prompt one",
      },
      {
        seq: 5,
        timestamp: "2026-01-01T00:00:04.000Z",
        preview: "Hidden via loaded stream trigger",
      },
    ];

    expect(isHiddenSystemOutlinePromptPreview(prompts[0]!.preview)).toBe(true);
    expect(isHiddenSystemOutlinePromptPreview(prompts[3]!.preview)).toBe(false);
    expect(filterChatOutlinePrompts(prompts, new Set([5]))).toEqual([prompts[3]]);
  });
});
