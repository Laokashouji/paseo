import { describe, expect, it } from "vitest";
import {
  buildPersonaHealthCheckUrl,
  isAllowedPersonaHealthCheckTarget,
  isAllowedPersonaTargetOrigin,
  isAllowedPersonaWebviewUrl,
  isPersonaWebviewAttach,
  isValidPersonaHubUrl,
  normalizePersonaHubUrl,
  parsePersonaSessionPath,
  PERSONA_OPEN_SESSION_EVENT,
  PERSONA_WEBVIEW_PARTITION,
} from "./policy.js";

describe("persona-webview policy", () => {
  it("exports expected partition and IPC event names", () => {
    expect(PERSONA_WEBVIEW_PARTITION).toBe("persist:persona");
    expect(PERSONA_OPEN_SESSION_EVENT).toBe("paseo:event:persona-open-session");
  });

  it("only allows http, https, and about:blank URLs for webview navigation", () => {
    expect(isAllowedPersonaWebviewUrl("http://127.0.0.1:18660")).toBe(true);
    expect(isAllowedPersonaWebviewUrl("https://persona.example.com/app")).toBe(true);
    expect(isAllowedPersonaWebviewUrl("about:blank")).toBe(true);

    expect(isAllowedPersonaWebviewUrl(undefined)).toBe(false);
    expect(isAllowedPersonaWebviewUrl("")).toBe(false);
    expect(isAllowedPersonaWebviewUrl("   ")).toBe(false);
    expect(isAllowedPersonaWebviewUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedPersonaWebviewUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedPersonaWebviewUrl("data:text/html,<h1>hi</h1>")).toBe(false);
    expect(isAllowedPersonaWebviewUrl("paseo://app/settings")).toBe(false);
    expect(isAllowedPersonaWebviewUrl("not-a-url")).toBe(false);
  });

  it("normalizes valid Hub URLs and rejects about:blank, unsafe schemes, and credentials", () => {
    expect(normalizePersonaHubUrl("http://127.0.0.1:18660/")).toEqual({
      url: "http://127.0.0.1:18660",
      origin: "http://127.0.0.1:18660",
      basePath: "",
      displayHost: "127.0.0.1:18660",
    });
    expect(normalizePersonaHubUrl("https://hub.example.com/persona///")).toEqual({
      url: "https://hub.example.com/persona",
      origin: "https://hub.example.com",
      basePath: "/persona",
      displayHost: "hub.example.com/persona",
    });

    expect(isValidPersonaHubUrl("about:blank")).toBe(false);
    expect(isValidPersonaHubUrl("file:///etc/passwd")).toBe(false);
    expect(isValidPersonaHubUrl("http://user:pass@127.0.0.1:18660")).toBe(false);
    expect(isValidPersonaHubUrl("")).toBe(false);
  });

  it("refuses persist:persona attach before a valid Hub is registered and enforces origin allowlisting", () => {
    // Unregistered Hub URL MUST be rejected (fail-closed)
    expect(
      isPersonaWebviewAttach({
        partition: PERSONA_WEBVIEW_PARTITION,
        src: "http://127.0.0.1:18660/",
      }),
    ).toBe(false);

    expect(
      isPersonaWebviewAttach(
        {
          partition: PERSONA_WEBVIEW_PARTITION,
          src: "http://127.0.0.1:18660/",
        },
        null,
      ),
    ).toBe(false);

    expect(
      isPersonaWebviewAttach(
        {
          partition: PERSONA_WEBVIEW_PARTITION,
          src: "http://127.0.0.1:18660/",
        },
        "about:blank",
      ),
    ).toBe(false);

    // Same-origin HTTP(S) src with a registered Hub is allowed
    expect(
      isPersonaWebviewAttach(
        {
          partition: PERSONA_WEBVIEW_PARTITION,
          src: "http://127.0.0.1:18660/persona",
        },
        "http://127.0.0.1:18660",
      ),
    ).toBe(true);

    // about:blank and embedded credentials cannot attach the privileged preload
    expect(
      isPersonaWebviewAttach(
        {
          partition: PERSONA_WEBVIEW_PARTITION,
          src: "about:blank",
        },
        "http://127.0.0.1:18660",
      ),
    ).toBe(false);

    expect(
      isPersonaWebviewAttach(
        {
          partition: PERSONA_WEBVIEW_PARTITION,
          src: "http://user:pass@127.0.0.1:18660/",
        },
        "http://127.0.0.1:18660",
      ),
    ).toBe(false);

    // Rejects wrong partition
    expect(
      isPersonaWebviewAttach(
        {
          partition: "persist:paseo-browser",
          src: "http://127.0.0.1:18660/",
        },
        "http://127.0.0.1:18660",
      ),
    ).toBe(false);

    // Rejects wrong protocol
    expect(
      isPersonaWebviewAttach(
        {
          partition: PERSONA_WEBVIEW_PARTITION,
          src: "file:///tmp/test.html",
        },
        "http://127.0.0.1:18660",
      ),
    ).toBe(false);

    // Rejects mismatched origin when configuredHubUrl is known
    expect(
      isPersonaWebviewAttach(
        {
          partition: PERSONA_WEBVIEW_PARTITION,
          src: "https://evil.example.com/",
        },
        "http://127.0.0.1:18660",
      ),
    ).toBe(false);
  });

  it("checks target origin and fixed health-check paths strictly", () => {
    expect(
      isAllowedPersonaTargetOrigin(
        "http://127.0.0.1:18660/s/n37-217-003/paseo-ag1",
        "http://127.0.0.1:18660",
      ),
    ).toBe(true);
    expect(isAllowedPersonaTargetOrigin("about:blank", "http://127.0.0.1:18660")).toBe(true);
    expect(isAllowedPersonaTargetOrigin("https://127.0.0.1:18662/", "http://127.0.0.1:18660")).toBe(
      false,
    );
    expect(isAllowedPersonaTargetOrigin("http://localhost:18660/", "http://127.0.0.1:18660")).toBe(
      false,
    );

    expect(buildPersonaHealthCheckUrl("https://hub.example.com/persona/")).toBe(
      "https://hub.example.com/persona/api/v1/health",
    );
    expect(buildPersonaHealthCheckUrl("about:blank")).toBeNull();

    expect(
      isAllowedPersonaHealthCheckTarget(
        "https://hub.example.com/persona/api/v1/health",
        "https://hub.example.com/persona",
      ),
    ).toBe(true);
    expect(
      isAllowedPersonaHealthCheckTarget(
        "https://hub.example.com/persona/api/v1/health/",
        "https://hub.example.com/persona",
      ),
    ).toBe(true);
    // Rejects off-origin or arbitrary paths on redirect
    expect(
      isAllowedPersonaHealthCheckTarget(
        "https://evil.example.com/persona/api/v1/health",
        "https://hub.example.com/persona",
      ),
    ).toBe(false);
    expect(
      isAllowedPersonaHealthCheckTarget(
        "https://hub.example.com/persona/api/v1/sessions",
        "https://hub.example.com/persona",
      ),
    ).toBe(false);
  });

  it("parses /s/:mid/:sid session paths with subpaths, query view, and encoded IDs", () => {
    expect(
      parsePersonaSessionPath(
        "http://127.0.0.1:18660/s/n37-217-003/paseo-ag_123?view=chat&work=1",
        "http://127.0.0.1:18660",
      ),
    ).toEqual({
      machineId: "n37-217-003",
      sessionId: "paseo-ag_123",
      view: "chat",
    });

    expect(
      parsePersonaSessionPath(
        "https://hub.example.com/persona-ui/s/%E5%BC%80%E5%8F%91%E6%9C%BA/sess-42?view=term",
        "https://hub.example.com/persona-ui/",
      ),
    ).toEqual({
      machineId: "开发机",
      sessionId: "sess-42",
      view: "term",
    });

    // Supports /t/:mid/:space/:slot/:sid when sid is present
    expect(
      parsePersonaSessionPath(
        "http://127.0.0.1:18660/t/n37-217-003/default/slot-1/paseo-ag_9",
        "http://127.0.0.1:18660",
      ),
    ).toEqual({
      machineId: "n37-217-003",
      sessionId: "paseo-ag_9",
    });
  });

  it("returns null for non-session Persona paths, wrong origins, or malformed encodings", () => {
    expect(parsePersonaSessionPath("http://127.0.0.1:18660/", "http://127.0.0.1:18660")).toBeNull();
    expect(
      parsePersonaSessionPath("http://127.0.0.1:18660/persona/abc", "http://127.0.0.1:18660"),
    ).toBeNull();
    expect(
      parsePersonaSessionPath("http://127.0.0.1:18660/settings", "http://127.0.0.1:18660"),
    ).toBeNull();
    expect(
      parsePersonaSessionPath(
        "https://other.example.com/s/n37-217-003/paseo-1",
        "http://127.0.0.1:18660",
      ),
    ).toBeNull();
    expect(
      parsePersonaSessionPath(
        "http://127.0.0.1:18660/s/n37-217-003/%E0%A4%A",
        "http://127.0.0.1:18660",
      ),
    ).toBeNull();
    expect(
      parsePersonaSessionPath(
        "https://hub.example.com/other-prefix/s/n37-217-003/paseo-1",
        "https://hub.example.com/persona-ui",
      ),
    ).toBeNull();
  });
});
