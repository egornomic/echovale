import { describe, expect, it } from "vitest";
import {
  parseWebFeedSelectionMessage,
  WEB_FEED_SELECT_MESSAGE,
} from "../../src/client/web-feed-selection.js";

const MESSAGE_TOKEN = "snapshot-message-token";
const CANDIDATE_IDS = new Set(["articles", "releases"]);

describe("web feed selection messages", () => {
  it("rejects stale, unknown, and unrelated messages", () => {
    expect(
      parseWebFeedSelectionMessage(
        {
          type: WEB_FEED_SELECT_MESSAGE,
          messageToken: "stale-token",
          candidateId: "articles",
        },
        MESSAGE_TOKEN,
        CANDIDATE_IDS,
      ),
    ).toBeNull();
    expect(
      parseWebFeedSelectionMessage(
        {
          type: WEB_FEED_SELECT_MESSAGE,
          messageToken: MESSAGE_TOKEN,
          candidateId: "products",
        },
        MESSAGE_TOKEN,
        CANDIDATE_IDS,
      ),
    ).toBeNull();
    expect(
      parseWebFeedSelectionMessage(
        {
          type: "feedfold:unrelated",
          messageToken: MESSAGE_TOKEN,
          candidateId: "articles",
        },
        MESSAGE_TOKEN,
        CANDIDATE_IDS,
      ),
    ).toBeNull();
  });
});
