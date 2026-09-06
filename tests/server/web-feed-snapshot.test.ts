import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  parseWebFeedSelectionMessage,
  webFeedHighlightMessage,
} from "../../src/client/web-feed-selection.js";
import { analyzeWebFeedDocument } from "../../src/server/web-feed-dom.js";
import { createWebFeedSnapshot } from "../../src/server/web-feed-snapshot.js";

describe("web-feed snapshot sanitization", () => {
  it("creates an inert, selectable copy of an analyzed document", async () => {
    const source = new JSDOM(
      `<!doctype html>
        <html>
          <head>
            <link rel="stylesheet" href="/fixture.css">
            <meta http-equiv="refresh" content="0; url=/elsewhere">
          </head>
          <body onload="window.compromised = true">
            <main>
              <article class="card">
                <h2><a href="/one" ping="/track">One</a></h2>
                <img src="/one.jpg" srcset="/one-2x.jpg 2x" alt="">
              </article>
              <article class="card">
                <h2><a href="/two">Two</a></h2>
                <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="">
              </article>
            </main>
            <form action="/subscribe"><input autofocus><button>Subscribe</button></form>
            <iframe src="/embedded"></iframe>
            <script>window.compromised = true</script>
          </body>
        </html>`,
      { url: "https://example.com/" },
    );
    const candidates = analyzeWebFeedDocument(
      source.window.document,
      "https://example.com/",
    ).candidates;
    const token = "snapshot-message-token";

    const html = createWebFeedSnapshot(source.window.document, candidates, token);

    expect(html).not.toContain("window.compromised");
    expect(html).not.toContain("/one.jpg");
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<iframe\b/i);
    expect(html).not.toMatch(/<form[^>]+action=/i);
    expect(html).not.toMatch(/<a[^>]+href=/i);
    expect(html).toContain("style-src 'unsafe-inline'; img-src data: blob:; font-src data:");

    const preview = new JSDOM(html, {
      runScripts: "dangerously",
      url: "https://preview.invalid/",
    });
    const messages: unknown[] = [];
    preview.window.addEventListener("message", (event) => messages.push(event.data));
    const firstSelectable = preview.window.document.querySelector<HTMLElement>(
      "[data-feedfold-candidates]",
    );
    expect(firstSelectable?.getAttribute("aria-label")).toContain("One");
    firstSelectable?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const candidateIds = new Set(candidates.map(({ candidate }) => candidate.id));
    expect(parseWebFeedSelectionMessage(messages.at(-1), token, candidateIds)).toEqual({
      kind: "select",
      candidateId: candidates[0]?.candidate.id,
    });
    expect(firstSelectable?.getAttribute("aria-pressed")).toBe("true");

    preview.window.dispatchEvent(new preview.window.KeyboardEvent("keydown", { key: "Escape" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(parseWebFeedSelectionMessage(messages.at(-1), token, candidateIds)).toEqual({
      kind: "select",
      candidateId: null,
    });
    expect(firstSelectable?.getAttribute("aria-pressed")).toBe("false");

    for (const candidateId of [candidates[0].candidate.id, null]) {
      preview.window.dispatchEvent(
        new preview.window.MessageEvent("message", {
          source: preview.window.parent,
          data: webFeedHighlightMessage(token, candidateId),
        }),
      );
      expect(firstSelectable?.getAttribute("aria-pressed")).toBe(String(candidateId !== null));
    }
    preview.window.close();
    source.window.close();
  });
});
