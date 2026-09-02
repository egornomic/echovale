import type { DesktopOperation } from "../shared/desktop.js";
import { createApiClient } from "./api-client.js";
import { ApiError, AUTH_REQUIRED_EVENT, appUrl } from "./api-contract.js";
import { invokeDesktop, isDesktopApp } from "./desktop.js";

export type {
  FeedInput,
  FeedUpdateInput,
  FolderInput,
  RuleInput,
} from "./api-contract.js";
export { ApiError, AUTH_REQUIRED_EVENT, appUrl, errorMessage } from "./api-contract.js";

async function httpRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(appUrl(path), { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    let message = `The request failed with HTTP ${response.status}. Try again.`;
    let code: string | null = null;
    let operationId: string | null = null;
    try {
      const body = (await response.json()) as {
        error?: string;
        message?: string;
        code?: string;
        operationId?: string;
      };
      message = body.error ?? body.message ?? message;
      code = body.code ?? null;
      operationId = body.operationId ?? null;
    } catch {
      // The status code still gives the user a useful error when no JSON body exists.
    }
    if (
      response.status === 401 &&
      !path.startsWith("/api/auth/") &&
      typeof window !== "undefined"
    ) {
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    }
    throw new ApiError(message, response.status, code, operationId);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(new DOMException("The request was aborted.", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("The request was aborted.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function request<T>(
  operation: DesktopOperation,
  payload: unknown,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!isDesktopApp()) return httpRequest<T>(path, init);
  try {
    return await abortable(invokeDesktop<T>(operation, payload), init?.signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const desktopError = error as Error & { status?: number; code?: string | null };
    throw new ApiError(desktopError.message, desktopError.status ?? 500, desktopError.code ?? null);
  }
}

function subscribeReaderDataInvalidations(listener: () => void): () => void {
  let active = true;
  const invalidate = () => {
    if (active) listener();
  };
  const bridge = window.feedfoldDesktop;
  const unsubscribe = bridge
    ? bridge.onDataChanged(invalidate)
    : (() => {
        const events = new EventSource(appUrl("/api/refresh/events"), { withCredentials: true });
        events.addEventListener("message", invalidate);
        events.addEventListener("error", invalidate);
        return () => events.close();
      })();

  const reconcileVisible = () => {
    if (document.visibilityState === "visible") invalidate();
  };
  window.addEventListener("online", invalidate);
  document.addEventListener("visibilitychange", reconcileVisible);

  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    window.removeEventListener("online", invalidate);
    document.removeEventListener("visibilitychange", reconcileVisible);
  };
}

async function exportOpml(): Promise<void> {
  const bridge = window.feedfoldDesktop;
  if (!bridge) {
    window.location.assign(appUrl("/api/opml/export"));
    return;
  }
  const response = await bridge.exportOpml();
  if (!response.ok) {
    throw new ApiError(response.error.message, response.error.status, response.error.code);
  }
}

export const api = createApiClient({
  request,
  subscribeReaderDataInvalidations,
  exportOpml,
});
