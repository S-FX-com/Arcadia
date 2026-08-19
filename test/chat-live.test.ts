import { describe, expect, it } from "vitest";
import { CHAT_LIVE_SCRIPT } from "../src/approval/chat-live";

describe("chat live script", () => {
  it("is valid JavaScript", () => {
    expect(() => new Function(CHAT_LIVE_SCRIPT)).not.toThrow();
  });

  it("takes over the form instead of navigating", () => {
    expect(CHAT_LIVE_SCRIPT).toContain("preventDefault");
    expect(CHAT_LIVE_SCRIPT).toContain("askArcadiaSend");
    expect(CHAT_LIVE_SCRIPT).toContain("/chat/send");
    expect(CHAT_LIVE_SCRIPT).toContain("/chat/updates");
  });
});
