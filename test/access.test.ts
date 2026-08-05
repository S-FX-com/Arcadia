import { describe, expect, it } from "vitest";
import { canOperateKillSwitch } from "../src/lib/access";

describe("canOperateKillSwitch", () => {
  const allowlist = "shane@s-fx.com, Diego@s-fx.com,vicky@s-fx.com";

  it("allows listed operators case-insensitively", () => {
    expect(canOperateKillSwitch("shane@s-fx.com", allowlist)).toBe(true);
    expect(canOperateKillSwitch("diego@s-fx.com", allowlist)).toBe(true);
    expect(canOperateKillSwitch("VICKY@S-FX.COM", allowlist)).toBe(true);
  });

  it("denies everyone else", () => {
    expect(canOperateKillSwitch("mallory@s-fx.com", allowlist)).toBe(false);
  });

  it("denies everyone when the allowlist is unset", () => {
    expect(canOperateKillSwitch("shane@s-fx.com", undefined)).toBe(false);
    expect(canOperateKillSwitch("shane@s-fx.com", "")).toBe(false);
  });
});
