import { describe, expect, it } from "vitest";
import { feedSourceUrl } from "../../src/client/feed-source.js";

describe("add feed source input", () => {
  it("keeps published and web feed URLs unchanged", () => {
    expect(feedSourceUrl("rss", " https://example.com/feed.xml ")).toBe(
      "https://example.com/feed.xml",
    );
    expect(feedSourceUrl("web", "https://example.com/articles")).toBe(
      "https://example.com/articles",
    );
  });

  it("turns Telegram and X handles into discoverable source URLs", () => {
    expect(feedSourceUrl("telegram", "Example_Channel")).toBe("https://t.me/Example_Channel");
    expect(feedSourceUrl("telegram", "@Example_Channel")).toBe("https://t.me/Example_Channel");
    expect(feedSourceUrl("x", "banteg")).toBe("https://x.com/banteg");
    expect(feedSourceUrl("x", "@banteg")).toBe("https://x.com/banteg");
  });

  it("rejects profile URLs where the form requires a handle", () => {
    expect(() => feedSourceUrl("telegram", "https://t.me/example")).toThrow(
      "Enter a Telegram handle",
    );
    expect(() => feedSourceUrl("x", "https://x.com/banteg")).toThrow("Enter an X handle");
  });
});
