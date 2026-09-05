import { describe, expect, it } from "vitest";
import {
  parseAndNormalizeFeed,
  parseAndNormalizeWordPressPosts,
} from "../../src/server/feed-parser.js";

describe("feed normalization", () => {
  it("preserves titleless entries without promoting their body to a headline", () => {
    const rss = parseAndNormalizeFeed(
      `<?xml version="1.0"?><rss version="2.0"><channel>
        <title>Posts</title><link>https://example.test/</link><description>Posts</description>
        <item><guid>one</guid><description><![CDATA[<p>The complete post body.</p>]]></description></item>
      </channel></rss>`,
      "https://example.test/rss.xml",
    );
    const nitter = parseAndNormalizeFeed(
      `<?xml version="1.0"?><rss version="2.0"><channel>
        <title>person / @person</title><link>https://x.com/person</link>
        <description>Twitter feed</description><item><guid>two</guid>
        <title>The complete tweet body.</title>
        <description><![CDATA[<p>The complete tweet body.</p>]]></description></item>
      </channel></rss>`,
      "https://x.com/person/rss",
    );

    expect(rss.articles[0]).toMatchObject({ title: "", summary: "The complete post body." });
    expect(nitter.articles[0]).toMatchObject({ title: "", summary: "The complete tweet body." });
  });

  it("normalizes RSS, Atom, and JSON Feed into the same article contract", () => {
    const rss = parseAndNormalizeFeed(
      `<?xml version="1.0"?><rss version="2.0"><channel>
        <title>RSS</title><link>https://example.test/</link><description>RSS feed</description>
        <item><guid>rss-1</guid><title>RSS article</title><link>/rss-article</link>
          <author>Ada</author><pubDate>Mon, 13 Jul 2026 12:00:00 GMT</pubDate>
          <description><![CDATA[<p>RSS summary</p>
            <img src="https://img.shields.io/badge/build-passing" alt="Build">
            <img src="https://slsa.dev/images/gh-badge-level3.svg?sanitize=true" alt="SLSA">
            <img src="https://camo.githubusercontent.com/b83ac8c3241beb7dfa1141f7cbf7408bc1802f0bd126bd93a3f55edf0aacd00f/68747470733a2f2f696d672e736869656c64732e696f2f6e706d2f64772f40776f6e6465727768792d65722f6465736b746f702d636f6d6d616e646572" alt="npm downloads">
            <img src="https://agentaudit.dev/api/badge/desktop-commander" alt="Agent audit">
            <img src="https://camo.githubusercontent.com/48c220b32dbd1c6cff7b530b14421078f44d32f0b7ceff5b564827f3340457b1/68747470733a2f2f7472656e6473686966742e696f2f6170692f62616467652f7265706f7369746f726965732f3231393538" alt="Trending">
            <img src="/hero.jpg" alt="Article hero">]]></description></item>
      </channel></rss>`,
      "https://example.test/rss.xml",
    );
    expect(rss).toMatchObject({
      title: "RSS",
      siteUrl: "https://example.test/",
      articles: [
        {
          externalId: "rss-1",
          title: "RSS article",
          url: "https://example.test/rss-article",
          author: "Ada",
          summary: "RSS summary",
          imageUrl: "https://example.test/hero.jpg",
          publishedAt: "2026-07-13T12:00:00.000Z",
        },
      ],
    });

    const atom = parseAndNormalizeFeed(
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
        <title>Atom</title><id>atom-feed</id><updated>2026-07-13T12:00:00Z</updated>
        <link rel="alternate" href="https://example.test/atom-home"/>
        <entry><title>Atom article</title><id>atom-1</id><updated>2026-07-13T13:00:00Z</updated>
          <link rel="alternate" href="/atom-article"/><author><name>Grace</name></author>
          <content type="html">&lt;p&gt;Atom full content&lt;/p&gt;</content></entry>
      </feed>`,
      "https://example.test/atom.xml",
    );
    expect(atom.articles[0]).toMatchObject({
      externalId: "atom-1",
      title: "Atom article",
      url: "https://example.test/atom-article",
      author: "Grace",
      summary: "Atom full content",
      feedContentHtml: "<p>Atom full content</p>",
    });

    const json = parseAndNormalizeFeed(
      JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "JSON",
        home_page_url: "https://example.test/json-home",
        items: [
          {
            id: "json-1",
            url: "/json-article",
            title: "JSON article",
            content_html: "<p>First line<br>Second &lt;unsafe&gt; line</p>",
            authors: [{ name: "Katherine" }],
            date_published: "2026-07-13T14:00:00Z",
          },
        ],
      }),
      "https://example.test/feed.json",
    );
    expect(json.articles[0]).toMatchObject({
      externalId: "json-1",
      title: "JSON article",
      url: "https://example.test/json-article",
      author: "Katherine",
      publishedAt: "2026-07-13T14:00:00.000Z",
      summary: "First line Second <unsafe> line",
    });
    expect(json.articles[0].feedContentHtml).toContain("Second &lt;unsafe&gt; line");
  });

  it("normalizes playable YouTube videos, thumbnails, and Shorts metadata", () => {
    const youtube = parseAndNormalizeFeed(
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"
        xmlns:yt="http://www.youtube.com/xml/schemas/2015"
        xmlns:media="http://search.yahoo.com/mrss/">
        <title>Example channel</title>
        <link rel="alternate" href="https://www.youtube.com/channel/UCexample"/>
        <author><name>Example channel</name></author>
        <entry>
          <id>yt:video:regular123</id><yt:videoId>regular123</yt:videoId>
          <yt:channelId>UCexample</yt:channelId><title>Regular upload</title>
          <link rel="alternate" href="https://www.youtube.com/watch?v=regular123"/>
          <published>2026-07-16T13:00:20+00:00</published>
          <media:group>
            <media:title>Regular upload</media:title>
            <media:thumbnail url="https://i2.ytimg.com/vi/regular123/hqdefault.jpg"
              width="480" height="360"/>
            <media:description>Useful video description.</media:description>
            <media:community>
              <media:starRating count="8" average="4.75" min="1" max="5"/>
              <media:statistics views="269"/>
            </media:community>
          </media:group>
        </entry>
        <entry>
          <id>yt:video:short123</id><yt:videoId>short123</yt:videoId>
          <yt:channelId>UCexample</yt:channelId><title>Short upload</title>
          <link rel="alternate" href="https://www.youtube.com/shorts/short123"/>
          <published>2026-07-15T14:09:22+00:00</published>
          <media:group>
            <media:title>Short upload</media:title>
            <media:thumbnail url="https://i3.ytimg.com/vi/short123/hqdefault.jpg"
              width="480" height="360"/>
            <media:description></media:description>
            <media:community><media:statistics views="10566"/></media:community>
          </media:group>
        </entry>
      </feed>`,
      "https://www.youtube.com/feeds/videos.xml?channel_id=UCexample",
    );

    expect(youtube.articles[0]).toMatchObject({
      title: "Regular upload",
      summary: "Useful video description.",
      imageUrl: "https://i2.ytimg.com/vi/regular123/hqdefault.jpg",
      media: {
        provider: "youtube",
        type: "video",
        videoId: "regular123",
        channelId: "UCexample",
        embedUrl: "https://www.youtube.com/embed/regular123",
        thumbnailUrl: "https://i2.ytimg.com/vi/regular123/hqdefault.jpg",
        viewCount: 269,
        rating: { average: 4.75, count: 8 },
      },
    });
    expect(youtube.articles[1]).toMatchObject({
      title: "Short upload",
      url: "https://www.youtube.com/shorts/short123",
      imageUrl: "https://i3.ytimg.com/vi/short123/hqdefault.jpg",
      media: {
        type: "short",
        videoId: "short123",
        viewCount: 10566,
        rating: null,
      },
    });
  });

  it("normalizes WordPress REST posts while preserving the stable post GUID", () => {
    const wordpress = parseAndNormalizeWordPressPosts(
      JSON.stringify([
        {
          guid: { rendered: "https://example.test/?p=42" },
          title: { rendered: "A &amp; B <em>together</em>" },
          link: "https://example.test/articles/a-and-b",
          date_gmt: "2026-07-13T14:00:00",
          date: "2026-07-13T16:00:00",
          excerpt: { rendered: "<p>Short &amp; useful summary.</p>" },
          content: {
            rendered: '<p>Full article</p><img src="/images/hero.jpg" alt="Hero">',
          },
        },
      ]),
      "https://example.test/wp-json/wp/v2/posts",
      "Example publication",
    );

    expect(wordpress).toEqual({
      title: "Example publication",
      siteUrl: "https://example.test",
      articles: [
        {
          externalId: "https://example.test/?p=42",
          title: "A & B together",
          url: "https://example.test/articles/a-and-b",
          author: null,
          publishedAt: "2026-07-13T14:00:00.000Z",
          summary: "Short & useful summary.",
          imageUrl: "https://example.test/images/hero.jpg",
          feedContentHtml: '<p>Full article</p><img src="/images/hero.jpg" alt="Hero">',
        },
      ],
    });
  });
});
