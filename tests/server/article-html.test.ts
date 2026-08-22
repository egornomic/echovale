import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { cleanArticleHtml } from "../../src/server/article-html.js";

function articleBody(html: string): HTMLElement {
  return new JSDOM(`<body>${html}</body>`).window.document.body;
}

describe("article HTML rendering", () => {
  it("preserves starred code and distinguishes their data and layout tables", () => {
    const html = cleanArticleHtml(
      `<p>Views are declarative markup in <code>.native</code> files.</p>
       <pre><code>native init my_app
cd my_app
native dev
</code></pre>
       <table><tbody><tr><td><img src="/notes.png" alt="Notes"></td><td><img src="/calculator.png" alt="Calculator"></td></tr></tbody></table>
       <table><thead><tr><th>Got a tip?</th></tr></thead><tbody><tr><td>Send it to WIRED.</td></tr></tbody></table>
       <table><thead><tr><th>Example</th><th>What it shows</th></tr></thead><tbody><tr><td>calculator</td><td>A complete small app.</td></tr></tbody></table>`,
      "https://github.com/vercel-labs/native",
    );
    const body = articleBody(html);
    const tables = body.querySelectorAll("table");

    expect(body.querySelector("pre code")?.textContent).toBe(
      "native init my_app\ncd my_app\nnative dev\n",
    );
    expect(body.querySelector("p code")?.textContent).toBe(".native");
    expect(tables).toHaveLength(3);
    expect(tables[0]?.closest(".article-table-scroll")).toBeNull();
    expect(tables[1]?.closest(".article-table-scroll")).toBeNull();
    expect(tables[2]?.parentElement).toMatchObject({
      className: "article-table-scroll",
      tabIndex: 0,
    });
    expect(tables[2]?.parentElement?.getAttribute("role")).toBe("region");
    expect(tables[2]?.parentElement?.getAttribute("aria-label")).toBe("Scrollable table");

    const cleanedAgain = articleBody(cleanArticleHtml(html));
    expect(cleanedAgain.querySelectorAll(".article-table-scroll")).toHaveLength(1);
  });

  it("associates the starred Torvalds attribution without absorbing Daring Fireball commentary", () => {
    const html = cleanArticleHtml(
      `<blockquote><p>I realize that some people really dislike AI, but this is an area where I'm willing to absolutely put my foot down as the top-level maintainer.</p></blockquote>
       <p>— <a href="https://lore.kernel.org/example">Linus Torvalds</a>, Linux Media Mailing List</p>
       <blockquote><p>OpenAI says it’s folding ChatGPT, Codex, and its developer-facing API into one core product team.</p></blockquote>
       <p>I’ll give them credit for sticking with a plan for two whole months to get this out the door.</p>`,
    );
    const body = articleBody(html);
    const quotes = body.querySelectorAll("blockquote");

    expect(quotes).toHaveLength(2);
    const attributedQuote = quotes[0]?.closest("figure.article-quote");
    expect(attributedQuote?.querySelector("figcaption")?.textContent).toContain(
      "Linus Torvalds, Linux Media Mailing List",
    );
    expect(attributedQuote?.nextElementSibling?.tagName).toBe("BLOCKQUOTE");
    expect(quotes[1]?.closest("figure")).toBeNull();
    expect(quotes[1]?.nextElementSibling?.textContent).toContain(
      "I’ll give them credit for sticking with a plan",
    );

    const cleanedAgain = articleBody(cleanArticleHtml(html));
    expect(cleanedAgain.querySelectorAll("figure.article-quote")).toHaveLength(1);
  });

  it("applies one quotation-mark treatment to prose, callouts, and structured quotes", () => {
    const html = cleanArticleHtml(
      `<blockquote>
         <p>Beginning July 20, Claude Fable 5 will be included in all Max and Team Premium plans, at 50% of limits.</p>
         <p>Pro and Team Standard users will continue to have access to Fable via usage credits, and will receive a one-time $100 credit.</p>
       </blockquote>
       <blockquote><p><strong>Abstract:</strong> This quotation starts with a former callout keyword.</p></blockquote>
       <blockquote><p>Under the new terms:</p><ul><li>Structured quotation item</li></ul></blockquote>
       <blockquote><p>[!TIP] Run <code>native check</code> before building.</p></blockquote>
       <blockquote><p>“This publisher already included an opening quote.”</p></blockquote>
       <blockquote>&quot;We are honored to share this update.&quot;</blockquote>
       <blockquote><p>„Ten wydawca również dodał znak otwierający.”</p></blockquote>
       <blockquote><p>Final quotation.</p></blockquote>`,
    );
    const body = articleBody(html);
    const quotes = body.querySelectorAll("blockquote");

    expect(quotes).toHaveLength(8);
    expect([...quotes].map((quote) => quote.className)).toEqual([
      "article-prose-quote-marked",
      "article-prose-quote-marked",
      "article-prose-quote-marked",
      "article-prose-quote-marked",
      "",
      "",
      "",
      "article-prose-quote-marked",
    ]);
    expect(body.querySelectorAll("blockquote > .article-quote-mark")).toHaveLength(5);
    for (const marker of body.querySelectorAll("blockquote > .article-quote-mark")) {
      expect(marker).toMatchObject({ ariaHidden: "true", textContent: "“" });
    }
    expect(quotes[1]?.textContent).toContain("Abstract: This quotation");
    expect(quotes[2]?.querySelector("ul li")?.textContent).toBe("Structured quotation item");
    expect(quotes[4]?.textContent).toContain("“This publisher already included");
    expect(quotes[6]?.textContent).toContain("„Ten wydawca również dodał");

    expect(cleanArticleHtml(html)).toBe(html);
  });

  it("applies the same quotation treatment to Telegram blockquotes", () => {
    const source = `<blockquote>Средняя продолжительность жизни российского военного на поле боя сейчас — <b>от 20 до 30 минут.</b><br><br><b>20–30 минут.</b> Это потому что ИИ-дроны стали специализированными машинами.</blockquote>
      <blockquote>&quot;Противники США, включая <b>как минимум Россию,</b> имеют возможности компрометировать инфраструктуру&quot;.</blockquote>
      <blockquote><b>Note:</b> This remains a callout.</blockquote>`;
    const telegramUrl = "https://t.me/ToBeOr_Official/21389";
    const html = cleanArticleHtml(source, telegramUrl);
    const body = articleBody(html);
    const quotes = body.querySelectorAll("blockquote");

    expect([...quotes].map((quote) => quote.className)).toEqual([
      "article-prose-quote-marked",
      "",
      "article-prose-quote-marked",
    ]);
    expect(body.querySelectorAll("blockquote > .article-quote-mark")).toHaveLength(2);
    expect(quotes[0]?.querySelector("b")?.textContent).toBe("от 20 до 30 минут.");
    expect(cleanArticleHtml(html, telegramUrl)).toBe(html);
    expect(cleanArticleHtml(source, "https://example.test/article")).toBe(html);
  });

  it("applies the same quotation treatment to Nitter quoted posts", () => {
    const source = `<p>Truth btw</p>
      <hr>
      <blockquote>
        <b>Barter (@BarterDeFi)</b>
        <p>But we at Barter are disappointed that the best thing Uniswap chose to put its effort into is a meme launchpad.<br>
        The market's largest shifts came from durable primitives: Bitcoin, Ethereum, Binance, Solana.<br>
        Not from people getting burned and scammed.</p>
        <video poster="/pic/tweet_video_thumb%2FHPhpv0WagAAaEYO.jpg" autoplay muted loop>
          <source src="/pic/video.twimg.com%2Ftweet_video%2FHPhpv0WagAAaEYO.mp4" type="video/mp4">
        </video>
        <footer>— <cite><a href="https://nitter.net/BarterDeFi/status/2087534708154675323#m">source post</a></cite></footer>
      </blockquote>`;
    const nitterUrl = "https://nitter.net/newmichwill/status/2087539154447999314#m";
    const html = cleanArticleHtml(source, nitterUrl);
    const quote = articleBody(html).querySelector("blockquote");

    expect(quote?.className).toBe("article-prose-quote-marked");
    expect(quote?.querySelector(":scope > .article-quote-mark")).toMatchObject({
      ariaHidden: "true",
      textContent: "“",
    });
    expect(quote?.querySelector(":scope > b")?.textContent).toBe("Barter (@BarterDeFi)");
    expect(quote?.querySelector("video source")).toMatchObject({
      src: "https://nitter.net/pic/video.twimg.com%2Ftweet_video%2FHPhpv0WagAAaEYO.mp4",
      type: "video/mp4",
    });
    expect(quote?.querySelector("footer a")).toMatchObject({
      href: "https://nitter.net/BarterDeFi/status/2087534708154675323#m",
      target: "_blank",
    });
    expect(cleanArticleHtml(html, nitterUrl)).toBe(html);
  });

  it("keeps commas inside responsive image URLs while resolving relative candidates", () => {
    const webpCandidate =
      "https://substackcdn.com/image/fetch/$s_!token!,w_424,c_limit,f_webp,q_auto:good/https%3A%2F%2Fmedia.example%2Fhero.png";
    const imageCandidate =
      "https://substackcdn.com/image/fetch/$s_!token!,w_424,c_limit,f_auto,q_auto:good/https%3A%2F%2Fmedia.example%2Fhero.png";
    const fallback =
      "https://substackcdn.com/image/fetch/$s_!token!,w_1456,c_limit,f_auto,q_auto:good/https%3A%2F%2Fmedia.example%2Fhero.png";
    const html = cleanArticleHtml(
      `<picture>
         <source type="image/webp" srcset="${webpCandidate} 424w, /images/hero-848.webp 848w">
         <img src="${fallback}" srcset="${imageCandidate} 424w, /images/hero-848.png 848w" alt="Hero">
       </picture>`,
      "https://publisher.example/p/article",
    );
    const body = articleBody(html);

    expect(body.querySelector("source")?.getAttribute("srcset")).toBe(
      `${webpCandidate} 424w, https://publisher.example/images/hero-848.webp 848w`,
    );
    expect(body.querySelector("img")?.getAttribute("srcset")).toBe(
      `${imageCandidate} 424w, https://publisher.example/images/hero-848.png 848w`,
    );
    expect(body.querySelector("img")?.getAttribute("src")).toBe(fallback);
    expect(html).not.toContain("https://publisher.example/p/w_424");
  });

  it("preserves Nitter inline videos while resolving their media URLs", () => {
    const sourceUrl = "https://nitter.net/person/status/2087000000000000000#m";
    const html = cleanArticleHtml(
      `<video poster="/pic/media%2Fposter.jpg" autoplay muted loop playsinline>
         <source src="/pic/tweet_video%2Ffixture.mp4" type="video/mp4">
       </video>`,
      sourceUrl,
    );
    const video = articleBody(html).querySelector("video");

    expect(video?.getAttribute("poster")).toBe("https://nitter.net/pic/media%2Fposter.jpg");
    expect(video?.hasAttribute("autoplay")).toBe(true);
    expect(video?.hasAttribute("muted")).toBe(true);
    expect(video?.hasAttribute("loop")).toBe(true);
    expect(video?.hasAttribute("playsinline")).toBe(true);
    expect(video?.querySelector("source")).toMatchObject({
      src: "https://nitter.net/pic/tweet_video%2Ffixture.mp4",
      type: "video/mp4",
    });
  });
});
