import { randomBytes } from "node:crypto";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
  errors as playwrightErrors,
  type Request,
} from "playwright";
import type { WebFeedConfig } from "../shared/types.js";
import {
  type PinnedAddress,
  PinnedPublicProxy,
  PublicNetworkError,
  publicProxyUrl,
  resolvePublicAddress,
} from "./public-network.js";
import { QuotaExceededError, type QuotaService } from "./quota.js";
import { WebFeedError } from "./web-feed-error.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SETTLE_QUIET_MS = 500;
const DEFAULT_SETTLE_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_DOCUMENT_BYTES = 5 * 1_024 * 1_024;
const DEFAULT_MAX_RESOURCE_BYTES = 32 * 1_024 * 1_024;
const DEFAULT_MAX_ELEMENTS = 50_000;
const DEFAULT_MAX_REQUESTS = 300;
const MAX_INLINE_STYLE_BYTES = 2 * 1_024 * 1_024;
const CONTENT_REQUEST_TYPES = new Set(["fetch", "script", "xhr"]);

type HostValidationCache = Map<string, Promise<void>>;

export interface WebFeedBrowserLoaderOptions {
  allowPrivateNetworks?: boolean;
  browserFactory?: () => Promise<Browser>;
  publicAddressResolver?: (hostname: string) => Promise<PinnedAddress>;
  timeoutMs?: number;
  settleQuietMs?: number;
  settleTimeoutMs?: number;
  maxDocumentBytes?: number;
  maxResourceBytes?: number;
  maxElements?: number;
  maxRequests?: number;
  quotas?: QuotaService;
}

export interface LoadedWebFeedPage {
  html: string;
  pageUrl: string;
  title: string;
  httpStatus: number | null;
  domContentLoaded: boolean;
  contentRequestFailure: ContentRequestFailure | null;
}

interface ContentRequestFailure {
  kind: "http" | "network";
  httpStatus: number | null;
}

function finitePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function singleLine(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function pageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebFeedError("Enter a valid public page URL.", "inaccessible");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFeedError(
      "Enter a public URL that begins with http:// or https://.",
      "inaccessible",
    );
  }
  if (url.username || url.password) {
    throw new WebFeedError(
      "Remove the username and password from this URL. Web feeds only support public pages.",
      "inaccessible",
    );
  }
  return url;
}

async function assertPublicPageUrl(
  value: string,
  allowPrivateNetworks: boolean,
  cache: HostValidationCache,
  addressResolver: (hostname: string) => Promise<PinnedAddress>,
): Promise<void> {
  const url = pageUrl(value);
  if (allowPrivateNetworks) return;
  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  let validation = cache.get(hostname);
  if (!validation) {
    validation = addressResolver(hostname)
      .then(() => undefined)
      .catch((error: unknown) => {
        if (error instanceof PublicNetworkError) {
          throw new WebFeedError(error.message, error.kind);
        }
        throw error;
      });
    cache.set(hostname, validation);
  }
  await validation;
}

function challengeDetected(title: string, bodyText: string): boolean {
  const pageText = `${title}\n${bodyText}`.toLowerCase();
  return [
    "verify you are human",
    "checking your browser",
    "complete the security check",
    "attention required! | cloudflare",
    "cf-chl-",
  ].some((phrase) => pageText.includes(phrase));
}

async function detectedChallenge(page: Page): Promise<boolean> {
  const content = await page.evaluate(() => ({
    title: document.title,
    bodyText: (document.body?.innerText ?? "").slice(0, 50_000),
  }));
  return challengeDetected(content.title, content.bodyText);
}

export function webFeedContentRequestError(loaded: LoadedWebFeedPage): WebFeedError | null {
  const failure = loaded.contentRequestFailure;
  if (!failure) return null;
  if (failure.kind === "http" && failure.httpStatus !== null) {
    return new WebFeedError(
      `This page could not finish loading its entries because one request returned HTTP ${failure.httpStatus}. Try again.`,
      "http",
      failure.httpStatus,
    );
  }
  return new WebFeedError(
    "This page could not finish loading its entries because one request failed. Try again.",
    "network",
  );
}

async function settleDom(
  page: Page,
  quietMs: number,
  timeoutMs: number,
  expectedConfig: WebFeedConfig | null,
  pendingRequestBinding: string,
): Promise<"ready" | "quiet_missing_selection" | "timeout"> {
  const minimumWaitMs = Math.min(timeoutMs, Math.max(expectedConfig ? 1_000 : 3_000, quietMs, 250));
  return page.evaluate(
    ({ expectedConfig, minimumWaitMs, pendingRequestBinding, quietMs, timeoutMs }) =>
      new Promise<"ready" | "quiet_missing_selection" | "timeout">((resolve) => {
        const root = document.documentElement;
        if (!root) {
          resolve("ready");
          return;
        }
        const startedAt = performance.now();
        let lastMutationAt = startedAt;
        let repeatedItemsCheckedAt = -1;
        let repeatedItemsReady = false;
        const observer = new MutationObserver(() => {
          lastMutationAt = performance.now();
        });
        observer.observe(root, { childList: true, subtree: true, characterData: true });
        const timer = setInterval(
          async () => {
            const now = performance.now();
            const quiet = now - lastMutationAt >= quietMs;
            const pendingRequests = await (
              window as unknown as Record<string, () => Promise<number>>
            )[pendingRequestBinding]();
            if (
              expectedConfig === null &&
              pendingRequests > 0 &&
              now - startedAt >= minimumWaitMs &&
              quiet &&
              repeatedItemsCheckedAt !== lastMutationAt
            ) {
              repeatedItemsCheckedAt = lastMutationAt;
              for (const parent of document.querySelectorAll("body, body *")) {
                if (
                  parent.closest(
                    'nav, header, footer, aside, [role="navigation"], [role="menu"], [aria-hidden="true"], [hidden]',
                  )
                ) {
                  continue;
                }
                const counts = new Map<string, number>();
                for (const child of parent.children) {
                  const tag = child.tagName.toLowerCase();
                  if (!["a", "article", "div", "li", "section", "tr"].includes(tag)) continue;
                  const link = child.matches("a[href]") ? child : child.querySelector("a[href]");
                  const rawHref = link?.getAttribute("href");
                  if (!rawHref) continue;
                  try {
                    const url = new URL(rawHref, location.href);
                    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
                  } catch {
                    continue;
                  }
                  const count = (counts.get(tag) ?? 0) + 1;
                  counts.set(tag, count);
                  if (count >= 2) {
                    repeatedItemsReady = true;
                    break;
                  }
                }
                if (repeatedItemsReady) break;
              }
            }
            let expectedSelectionReady = expectedConfig === null;
            if (expectedConfig) {
              try {
                let matches = 0;
                for (const item of document.querySelectorAll(expectedConfig.selectors.item)) {
                  const link =
                    expectedConfig.selectors.link === ":scope"
                      ? item
                      : item.querySelector(expectedConfig.selectors.link);
                  const rawHref = link?.getAttribute("href") ?? link?.getAttribute("data-href");
                  if (!rawHref) continue;
                  const url = new URL(rawHref, location.href);
                  if (url.protocol !== "http:" && url.protocol !== "https:") continue;
                  matches += 1;
                  if (matches >= 1) {
                    expectedSelectionReady = true;
                    break;
                  }
                }
              } catch {
                expectedSelectionReady = false;
              }
            }
            if (
              now - startedAt >= minimumWaitMs &&
              quiet &&
              expectedSelectionReady &&
              (expectedConfig !== null || pendingRequests === 0 || repeatedItemsReady)
            ) {
              clearInterval(timer);
              observer.disconnect();
              resolve("ready");
            } else if (now - startedAt >= timeoutMs) {
              clearInterval(timer);
              observer.disconnect();
              resolve(
                expectedConfig !== null && quiet && pendingRequests === 0
                  ? "quiet_missing_selection"
                  : "timeout",
              );
            }
          },
          Math.min(100, quietMs),
        );
      }),
    { expectedConfig, minimumWaitMs, pendingRequestBinding, quietMs, timeoutMs },
  );
}

async function materializeOpenShadowRoots(page: Page): Promise<void> {
  await page.evaluate(() => {
    const roots: Array<Document | ShadowRoot> = [document];
    while (roots.length > 0) {
      const root = roots.pop();
      if (!root) continue;
      for (const element of root.querySelectorAll("*")) {
        if (!element.shadowRoot) continue;
        roots.push(element.shadowRoot);
        const container = document.createElement("div");
        container.setAttribute("data-feedfold-shadow-root", "");
        for (const child of element.shadowRoot.childNodes) container.append(child.cloneNode(true));
        element.append(container);
      }
    }
  });
}

async function inlineComputedStyles(page: Page, byteLimit: number): Promise<void> {
  await page.evaluate((byteLimit) => {
    const properties = [
      "accent-color",
      "align-content",
      "align-items",
      "align-self",
      "aspect-ratio",
      "background-color",
      "border-bottom-color",
      "border-bottom-left-radius",
      "border-bottom-right-radius",
      "border-bottom-style",
      "border-bottom-width",
      "border-left-color",
      "border-left-style",
      "border-left-width",
      "border-right-color",
      "border-right-style",
      "border-right-width",
      "border-top-color",
      "border-top-left-radius",
      "border-top-right-radius",
      "border-top-style",
      "border-top-width",
      "box-shadow",
      "box-sizing",
      "clear",
      "color",
      "column-gap",
      "display",
      "flex-basis",
      "flex-direction",
      "flex-grow",
      "flex-shrink",
      "flex-wrap",
      "float",
      "font-family",
      "font-size",
      "font-style",
      "font-weight",
      "gap",
      "grid-auto-columns",
      "grid-auto-flow",
      "grid-auto-rows",
      "grid-template-columns",
      "grid-template-rows",
      "height",
      "justify-content",
      "justify-items",
      "justify-self",
      "letter-spacing",
      "line-height",
      "list-style-position",
      "list-style-type",
      "margin-bottom",
      "margin-left",
      "margin-right",
      "margin-top",
      "max-height",
      "max-width",
      "min-height",
      "min-width",
      "object-fit",
      "opacity",
      "order",
      "overflow-wrap",
      "overflow-x",
      "overflow-y",
      "padding-bottom",
      "padding-left",
      "padding-right",
      "padding-top",
      "position",
      "row-gap",
      "table-layout",
      "text-align",
      "text-decoration-color",
      "text-decoration-line",
      "text-decoration-style",
      "text-indent",
      "text-overflow",
      "text-transform",
      "transform",
      "transform-origin",
      "vertical-align",
      "visibility",
      "white-space",
      "width",
      "word-break",
      "z-index",
    ];
    const elements: Element[] = [];
    const roots: Array<Document | ShadowRoot> = [document];
    while (roots.length > 0) {
      const root = roots.pop();
      if (!root) continue;
      for (const element of root.querySelectorAll("*")) {
        elements.push(element);
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    const captured: Array<{ element: HTMLElement | SVGElement; cssText: string }> = [];
    let capturedBytes = 0;
    for (const element of elements) {
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue;
      if (
        element.matches("script, noscript, iframe, frame, object, embed, template, style, link")
      ) {
        continue;
      }
      const computed = getComputedStyle(element);
      const hidden = computed.display === "none" || computed.visibility === "hidden";
      const selectedProperties = hidden ? ["display", "visibility"] : properties;
      const cssText = selectedProperties
        .map((property) => `${property}:${computed.getPropertyValue(property)};`)
        .join("");
      const nextBytes = new TextEncoder().encode(cssText).byteLength;
      if (capturedBytes + nextBytes > byteLimit) break;
      capturedBytes += nextBytes;
      captured.push({ element, cssText });
    }
    for (const { element, cssText } of captured) element.style.cssText = cssText;
  }, byteLimit);
}

function browserFailure(error: unknown): WebFeedError {
  if (error instanceof WebFeedError) return error;
  if (error instanceof playwrightErrors.TimeoutError) {
    return new WebFeedError("This page took too long to load. Try again.", "timeout", null, {
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : "Unknown browser error";
  if (/executable doesn't exist|browser.*not found|failed to launch/i.test(message)) {
    return new WebFeedError(
      "This feedfold server cannot load JavaScript pages. Check the server's Chromium setup.",
      "unsupported_content",
      null,
      { cause: error },
    );
  }
  return new WebFeedError(
    "Could not load this page. Check the address, then try again.",
    "network",
    null,
    { cause: error },
  );
}

export class WebFeedBrowserLoader {
  readonly #allowPrivateNetworks: boolean;
  readonly #addressResolver: (hostname: string) => Promise<PinnedAddress>;
  readonly #browserFactory: () => Promise<Browser>;
  readonly #usesSharedPublicProxy: boolean;
  readonly #timeoutMs: number;
  readonly #settleQuietMs: number;
  readonly #settleTimeoutMs: number;
  readonly #maxDocumentBytes: number;
  readonly #maxResourceBytes: number;
  readonly #maxElements: number;
  readonly #maxRequests: number;
  readonly #quotas: QuotaService | undefined;
  #browserPromise: Promise<Browser> | null = null;
  #customPublicProxy: PinnedPublicProxy | null = null;
  #closed = false;

  constructor(options: WebFeedBrowserLoaderOptions = {}) {
    this.#allowPrivateNetworks = options.allowPrivateNetworks ?? false;
    this.#addressResolver = options.publicAddressResolver ?? resolvePublicAddress;
    this.#usesSharedPublicProxy = options.publicAddressResolver === undefined;
    this.#browserFactory =
      options.browserFactory ??
      (() =>
        chromium.launch({
          args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
          headless: true,
          chromiumSandbox: process.platform === "linux",
        }));
    this.#timeoutMs = finitePositive(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.#settleQuietMs = finitePositive(options.settleQuietMs, DEFAULT_SETTLE_QUIET_MS);
    this.#settleTimeoutMs = finitePositive(options.settleTimeoutMs, DEFAULT_SETTLE_TIMEOUT_MS);
    this.#maxDocumentBytes = finitePositive(options.maxDocumentBytes, DEFAULT_MAX_DOCUMENT_BYTES);
    this.#maxResourceBytes = finitePositive(options.maxResourceBytes, DEFAULT_MAX_RESOURCE_BYTES);
    this.#maxElements = finitePositive(options.maxElements, DEFAULT_MAX_ELEMENTS);
    this.#maxRequests = finitePositive(options.maxRequests, DEFAULT_MAX_REQUESTS);
    this.#quotas = options.quotas;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const browserPromise = this.#browserPromise;
    this.#browserPromise = null;
    if (browserPromise) {
      const browser = await browserPromise.catch(() => null);
      await browser?.close().catch(() => undefined);
    }
    await this.#customPublicProxy?.close();
    this.#customPublicProxy = null;
  }

  async publicCandidates<T extends { articleUrls: string[] }>(candidates: T[]): Promise<T[]> {
    if (this.#allowPrivateNetworks) return candidates;
    const accepted: T[] = [];
    const cache: HostValidationCache = new Map();
    for (const candidate of candidates) {
      try {
        await this.#validateUrls(candidate.articleUrls, cache);
        accepted.push(candidate);
      } catch (error) {
        if (error instanceof WebFeedError && error.kind === "inaccessible") continue;
        throw error;
      }
    }
    return accepted;
  }

  async validateArticleUrls(urls: string[]): Promise<void> {
    await this.#validateUrls(urls, new Map());
  }

  async #validateUrls(urls: string[], cache: HostValidationCache): Promise<void> {
    for (const url of urls) {
      await assertPublicPageUrl(url, this.#allowPrivateNetworks, cache, this.#addressResolver);
    }
  }

  async #browser(): Promise<Browser> {
    if (this.#closed) throw new WebFeedError("Web feed loading stopped. Try again.", "network");
    if (!this.#browserPromise) {
      const browserPromise = this.#browserFactory();
      this.#browserPromise = browserPromise;
      void browserPromise.then(
        (browser) => {
          browser.once("disconnected", () => {
            if (this.#browserPromise === browserPromise) this.#browserPromise = null;
          });
        },
        () => {
          if (this.#browserPromise === browserPromise) this.#browserPromise = null;
        },
      );
    }
    try {
      return await this.#browserPromise;
    } catch (error) {
      throw browserFailure(error);
    }
  }

  async #proxyUrl(): Promise<string> {
    if (this.#usesSharedPublicProxy) return publicProxyUrl();
    this.#customPublicProxy ??= new PinnedPublicProxy(this.#timeoutMs, this.#addressResolver);
    return this.#customPublicProxy.url();
  }

  async load(
    inputUrl: string,
    expectedConfig: WebFeedConfig | null = null,
  ): Promise<LoadedWebFeedPage> {
    const validationCache: HostValidationCache = new Map();
    await assertPublicPageUrl(
      inputUrl,
      this.#allowPrivateNetworks,
      validationCache,
      this.#addressResolver,
    );
    const browser = await this.#browser();
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let fatalError: Error | null = null;
    let requestCount = 0;
    let declaredResourceBytes = 0;
    let transferredResourceBytes = 0;
    let contentRequestFailure: ContentRequestFailure | null = null;
    const pendingContentRequests = new Set<Request>();
    const outboundRequests = new Map<Request, () => void>();
    const releaseOutbound = (request: Request): void => {
      const release = outboundRequests.get(request);
      outboundRequests.delete(request);
      release?.();
    };
    const pendingRequestBinding = `__feedfoldPending${randomBytes(12).toString("hex")}`;
    try {
      context = await browser.newContext({
        acceptDownloads: false,
        javaScriptEnabled: true,
        permissions: [],
        proxy: this.#allowPrivateNetworks ? undefined : { server: await this.#proxyUrl() },
        serviceWorkers: "block",
        viewport: { width: 900, height: 900 },
      });
      page = await context.newPage();
      await page.exposeFunction(pendingRequestBinding, () => pendingContentRequests.size);
      page.on("request", (request) => {
        if (CONTENT_REQUEST_TYPES.has(request.resourceType())) {
          pendingContentRequests.add(request);
        }
      });
      page.on("requestfinished", (request) => {
        pendingContentRequests.delete(request);
        releaseOutbound(request);
      });
      page.on("requestfailed", (request) => {
        releaseOutbound(request);
        if (CONTENT_REQUEST_TYPES.has(request.resourceType())) {
          pendingContentRequests.delete(request);
          contentRequestFailure ??= { kind: "network", httpStatus: null };
        }
      });
      const devtools = await context.newCDPSession(page);
      await devtools.send("Network.enable");
      devtools.on("Network.dataReceived", (event) => {
        transferredResourceBytes += event.dataLength;
        if (transferredResourceBytes > this.#maxResourceBytes && !fatalError) {
          fatalError = new WebFeedError(
            "This page loads too much data to become a reliable web feed. Choose another page.",
            "unsupported_content",
          );
          void page?.close();
        }
      });
      page.on("dialog", (dialog) => void dialog.dismiss());
      page.on("download", (download) => void download.cancel());
      page.on("popup", (popup) => void popup.close());
      page.on("response", (response) => {
        if (
          CONTENT_REQUEST_TYPES.has(response.request().resourceType()) &&
          response.status() >= 400
        ) {
          contentRequestFailure ??= { kind: "http", httpStatus: response.status() };
        }
        const length = Number(response.headers()["content-length"]);
        if (!Number.isFinite(length) || length <= 0) return;
        declaredResourceBytes += length;
        if (declaredResourceBytes > this.#maxResourceBytes && !fatalError) {
          fatalError = new WebFeedError(
            "This page loads too much data to become a reliable web feed. Choose another page.",
            "unsupported_content",
          );
          void page?.close();
        }
      });
      await context.route("**/*", async (route) => {
        requestCount += 1;
        if (requestCount > this.#maxRequests) {
          fatalError ??= new WebFeedError(
            "This page makes too many requests to become a reliable web feed. Choose another page.",
            "unsupported_content",
          );
          await route.abort("blockedbyclient");
          return;
        }
        const request = route.request();
        if (request.resourceType() === "media") {
          await route.abort("blockedbyclient");
          return;
        }
        try {
          const requestUrl = request.url();
          if (!/^(?:about|blob|data):/i.test(requestUrl)) {
            await assertPublicPageUrl(
              requestUrl,
              this.#allowPrivateNetworks,
              validationCache,
              this.#addressResolver,
            );
            const release = this.#quotas?.startOutboundRequest();
            if (release) outboundRequests.set(request, release);
          }
          await route.continue();
        } catch (error) {
          releaseOutbound(request);
          if (error instanceof QuotaExceededError) {
            fatalError = error;
            void page?.close();
          } else if (request.isNavigationRequest() && request.frame() === page?.mainFrame()) {
            fatalError = browserFailure(error);
          }
          await route.abort("blockedbyclient");
        }
      });
      await context.routeWebSocket(/.*/, async (socket) => {
        try {
          const socketUrl = socket.url().replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
          await assertPublicPageUrl(
            socketUrl,
            this.#allowPrivateNetworks,
            validationCache,
            this.#addressResolver,
          );
          const release = this.#quotas?.startOutboundRequest();
          release?.();
          socket.connectToServer();
        } catch {
          await socket.close({ code: 1008, reason: "Private network connections are blocked" });
        }
      });

      let response: Awaited<ReturnType<Page["goto"]>>;
      try {
        response = await page.goto(pageUrl(inputUrl).toString(), {
          timeout: this.#timeoutMs,
          waitUntil: "commit",
        });
      } catch (error) {
        if (fatalError) throw fatalError;
        throw browserFailure(error);
      }
      if (fatalError) throw fatalError;
      if (!response)
        throw new WebFeedError(
          "Could not load this page. Check the address, then try again.",
          "network",
        );
      const status = response.status();
      if (status === 401 || status === 407) {
        throw new WebFeedError(
          "This page is not public. Use a page that does not require sign-in.",
          "inaccessible",
          status,
        );
      }
      if (status === 403 || status === 429) {
        throw new WebFeedError(
          "This page blocked automated loading. Choose another page, or try again later.",
          "access_blocked",
          status,
        );
      }
      if (status >= 400) {
        throw new WebFeedError(
          `This page returned HTTP ${status}. Try again later.`,
          "http",
          status,
        );
      }
      const headers = response.headers();
      const contentType = headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType && contentType !== "text/html" && contentType !== "application/xhtml+xml") {
        throw new WebFeedError(
          "This URL does not return an HTML page. Choose a website page instead.",
          "unsupported_content",
          status,
        );
      }
      if (/attachment/i.test(headers["content-disposition"] ?? "")) {
        throw new WebFeedError(
          "This URL starts a download. Choose an HTML page instead.",
          "unsupported_content",
          status,
        );
      }
      const declaredDocumentBytes = Number(headers["content-length"]);
      if (
        Number.isFinite(declaredDocumentBytes) &&
        declaredDocumentBytes > this.#maxDocumentBytes
      ) {
        throw new WebFeedError(
          "This page is too large to become a reliable web feed. Choose another page.",
          "unsupported_content",
          status,
        );
      }
      const domContentLoaded = await page
        .waitForLoadState("domcontentloaded", {
          timeout: Math.min(5_000, this.#timeoutMs),
        })
        .then(
          () => true,
          () => false,
        );
      if (await detectedChallenge(page)) {
        throw new WebFeedError(
          "This page requires a CAPTCHA or bot check that feedfold cannot complete. Choose another page.",
          "access_blocked",
          status,
        );
      }
      const settled = await settleDom(
        page,
        this.#settleQuietMs,
        this.#settleTimeoutMs,
        expectedConfig,
        pendingRequestBinding,
      );
      if (settled === "timeout") {
        throw new WebFeedError(
          "This page's JavaScript did not finish in time. Try again.",
          "javascript_timeout",
          status,
        );
      }
      if (fatalError) throw fatalError;
      const title =
        singleLine(await page.title()) || new URL(page.url()).hostname.replace(/^www\./, "");
      const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
      if (challengeDetected(title, bodyText.slice(0, 50_000))) {
        throw new WebFeedError(
          "This page requires a CAPTCHA or bot check that feedfold cannot complete. Choose another page.",
          "access_blocked",
          status,
        );
      }
      const initialElementCount = await page.locator("*").count();
      if (initialElementCount > this.#maxElements) {
        throw new WebFeedError(
          "This page has too many elements to become a reliable web feed. Choose another page.",
          "unsupported_content",
          status,
        );
      }
      await inlineComputedStyles(
        page,
        Math.min(MAX_INLINE_STYLE_BYTES, Math.floor(this.#maxDocumentBytes / 2)),
      );
      await materializeOpenShadowRoots(page);
      const elementCount = await page.locator("*").count();
      if (elementCount > this.#maxElements) {
        throw new WebFeedError(
          "This page has too many elements to become a reliable web feed. Choose another page.",
          "unsupported_content",
          status,
        );
      }
      const html = await page.content();
      if (Buffer.byteLength(html, "utf8") > this.#maxDocumentBytes) {
        throw new WebFeedError(
          "This page is too large to become a reliable web feed. Choose another page.",
          "unsupported_content",
          status,
        );
      }
      if (!singleLine(bodyText)) {
        if (!domContentLoaded) {
          throw new WebFeedError(
            "This page did not finish loading before feedfold could read it. Try again.",
            "javascript_timeout",
            status,
          );
        }
        throw new WebFeedError(
          "This page did not contain readable entries. Choose another page.",
          "unsupported_content",
          status,
        );
      }
      return {
        html,
        pageUrl: page.url(),
        title,
        httpStatus: status,
        domContentLoaded,
        contentRequestFailure,
      };
    } catch (error) {
      if (fatalError) throw fatalError;
      if (error instanceof QuotaExceededError) throw error;
      throw browserFailure(error);
    } finally {
      for (const release of outboundRequests.values()) release();
      outboundRequests.clear();
      await context?.close().catch(() => undefined);
    }
  }
}
