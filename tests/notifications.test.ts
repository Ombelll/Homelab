import { describe, it, expect } from "vitest";
import { redactConfig, validateChannelConfig } from "@/lib/notifications";

describe("redactConfig", () => {
  it("masks discord webhook URL to host only", () => {
    const out = redactConfig("discord", {
      webhookUrl: "https://discord.com/api/webhooks/123/secrettoken",
    }) as Record<string, unknown>;
    expect(out.webhookUrl).toBe("https://discord.com/…");
    expect(out.secretSet).toBe(true);
  });

  it("redacts ntfy token but leaves topic + server visible", () => {
    const out = redactConfig("ntfy", {
      server: "https://ntfy.example",
      topic: "alerts",
      token: "tk_supersecret",
    }) as Record<string, unknown>;
    expect(out.topic).toBe("alerts");
    expect(out.server).toBe("https://ntfy.example");
    expect(out.token).toBe("***");
  });

  it("returns empty object for non-object input", () => {
    expect(redactConfig("discord", null)).toEqual({});
    expect(redactConfig("discord", "string")).toEqual({});
  });
});

describe("validateChannelConfig", () => {
  it("accepts a valid discord webhook URL", () => {
    const r = validateChannelConfig("discord", {
      webhookUrl: "https://discord.com/api/webhooks/1/abc",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects discord without a URL", () => {
    const r = validateChannelConfig("discord", { webhookUrl: "not-a-url" });
    expect(r.ok).toBe(false);
  });

  it("ntfy defaults server when omitted", () => {
    const r = validateChannelConfig("ntfy", { topic: "homelab" });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as { server: string }).server).toBe("https://ntfy.sh");
  });

  it("webhook requires url", () => {
    expect(validateChannelConfig("webhook", {}).ok).toBe(false);
    expect(validateChannelConfig("webhook", { url: "https://example/post" }).ok).toBe(true);
  });
});
