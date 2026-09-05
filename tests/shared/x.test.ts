import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  withXVideoPlaceholder,
  xPostId,
  xVideoPlaceholderId,
  xVideoPostId,
} from "../../src/shared/x.js";

const VIDEO_POST_ID = "2086315104472383847";
const OUTER_POST_ID = "2086315619226681697";
const CONTENT = `<p>Thank you for understanding 🙏</p><blockquote><b>Quoted post</b>
<a href="https://x.com/marclou/status/${VIDEO_POST_ID}#m"><br>Video<br>
<img src="https://pbs.twimg.com/amplify_video_thumb/2086314948196765696/img/poster.jpg"></a></blockquote>
<p>— <a href="https://x.com/marclou/status/${OUTER_POST_ID}#m">source post</a></p>`;
const CURRENT_POSTER_ID = "2087231350134980830";
const CURRENT_POSTER_CONTENT = `<p>Now in preview: The ChatGPT desktop app for Linux.</p>
<a href="https://x.com/OpenAI/status/${CURRENT_POSTER_ID}#m"><br>Video<br>
<img src="https://pbs.twimg.com/media/HPdd088aAAAEfFu.jpg"></a>`;

describe("X video helpers", () => {
  it("extracts post IDs from X status URLs", () => {
    expect(xPostId(`https://x.com/marclou/status/${VIDEO_POST_ID}#m`)).toBe(VIDEO_POST_ID);
    expect(xPostId(`https://example.com/marclou/status/${VIDEO_POST_ID}`)).toBeNull();
  });

  it("uses the linked video post ID when an outer post quotes native video", () => {
    expect(xVideoPostId(`https://x.com/marclou/status/${OUTER_POST_ID}#m`, CONTENT)).toBe(
      VIDEO_POST_ID,
    );
  });

  it("replaces the stale poster with a player slot inside the quoted post", () => {
    const placeholderId = xVideoPlaceholderId(42);
    const cleaned = withXVideoPlaceholder(CONTENT, VIDEO_POST_ID, 42);
    const fragment = JSDOM.fragment(cleaned);

    expect(cleaned).not.toContain("amplify_video_thumb");
    expect(cleaned).toContain("Thank you for understanding");
    expect(cleaned).toContain(`status/${OUTER_POST_ID}#m`);
    expect(fragment.querySelector(`blockquote > #${placeholderId}`)).not.toBeNull();
  });

  it("recognizes standard X uploads as well as amplified videos", () => {
    const html = `<a href="https://x.com/marclou/status/${VIDEO_POST_ID}#m"><br>Video<br><img src="https://pbs.twimg.com/ext_tw_video_thumb/fixture.jpg"></a>`;
    expect(xVideoPostId(null, html)).toBe(VIDEO_POST_ID);
  });

  it("recognizes videos whose current Nitter poster uses an ordinary media URL", () => {
    expect(xVideoPostId(null, CURRENT_POSTER_CONTENT)).toBe(CURRENT_POSTER_ID);
    expect(withXVideoPlaceholder(CURRENT_POSTER_CONTENT, CURRENT_POSTER_ID, 7).trim()).toBe(
      '<p>Now in preview: The ChatGPT desktop app for Linux.</p>\n<div id="article-7-x-video"></div>',
    );
  });

  it("does not treat ordinary linked images that merely mention video as players", () => {
    const html = `<a href="https://x.com/person/status/${CURRENT_POSTER_ID}#m">Video<br><img src="https://pbs.twimg.com/media/fixture.jpg"><br>from yesterday</a>`;
    expect(xVideoPostId(null, html)).toBeNull();
  });
});
