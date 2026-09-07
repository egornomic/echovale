import { ExternalLink, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAnimatedDialog } from "./motion.js";

export interface ImageLightboxItem {
  src: string;
  alt: string;
}

export interface ImageLightboxState {
  images: ImageLightboxItem[];
  index: number;
  returnFocus: HTMLElement | null;
}

const ZOOM_STEP = 0.05;
const WHEEL_ZOOM_THRESHOLD = 40;
const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;

function externalHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function ImageLightbox({
  state,
  onClose,
}: {
  state: ImageLightboxState;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(state.index);
  const [zoom, setZoom] = useState<number | null>(null);
  const fittedSize = useRef<{ width: number; height: number } | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const wheelDelta = useRef(0);
  const finishClose = useCallback(() => {
    onClose();
    window.requestAnimationFrame(() => state.returnFocus?.focus());
  }, [onClose, state.returnFocus]);
  const dialog = useAnimatedDialog(finishClose);
  const image = state.images[index] ?? state.images[0];
  const multiple = state.images.length > 1;

  const resetView = useCallback(() => {
    setZoom(null);
    fittedSize.current = null;
    wheelDelta.current = 0;
    if (typeof stageRef.current?.scrollTo === "function") {
      stageRef.current.scrollTo({ top: 0, left: 0 });
    }
  }, []);

  const showImage = useCallback(
    (nextIndex: number) => {
      const count = state.images.length;
      if (count < 1) return;
      const normalizedIndex = (nextIndex + count) % count;
      if (normalizedIndex !== index) {
        if (state.images[normalizedIndex]?.src !== state.images[index]?.src) {
          setLoadState("loading");
        }
        setIndex(normalizedIndex);
      }
      resetView();
    },
    [index, resetView, state.images],
  );

  const changeZoom = useCallback((direction: number) => {
    const element = imageRef.current;
    if (!element?.naturalWidth) return;
    fittedSize.current ??= element.getBoundingClientRect();
    setZoom((current) =>
      Math.min(4, Math.max(0.1, Number(((current ?? 1) + direction * ZOOM_STEP).toFixed(2)))),
    );
  }, []);
  const zoomIn = useCallback(() => changeZoom(1), [changeZoom]);
  const zoomOut = useCallback(() => changeZoom(-1), [changeZoom]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const delta =
        event.deltaMode === WHEEL_DELTA_LINE
          ? event.deltaY * 16
          : event.deltaMode === WHEEL_DELTA_PAGE
            ? event.deltaY * stage.clientHeight
            : event.deltaY;
      if (Math.sign(delta) !== Math.sign(wheelDelta.current)) wheelDelta.current = 0;
      wheelDelta.current += delta;
      if (Math.abs(wheelDelta.current) < WHEEL_ZOOM_THRESHOLD) return;
      if (wheelDelta.current < 0) zoomIn();
      else zoomOut();
      wheelDelta.current = 0;
    };
    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, [zoomIn, zoomOut]);

  useEffect(() => {
    dialog.dialogRef.current?.focus({ preventScroll: true });
  }, [dialog.dialogRef]);

  if (!image) return null;
  const imageUrl = externalHttpUrl(image.src);
  const imageStyle =
    zoom !== null && fittedSize.current
      ? {
          width: fittedSize.current.width * zoom,
          height: fittedSize.current.height * zoom,
          maxWidth: "none",
          maxHeight: "none",
        }
      : undefined;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled in capture so article shortcuts cannot receive it.
    <dialog
      ref={dialog.dialogRef}
      className="image-lightbox"
      tabIndex={-1}
      data-state={dialog.closing ? "closing" : "open"}
      aria-label="Image preview"
      onCancel={dialog.handleCancel}
      onClose={dialog.handleClose}
      onKeyDownCapture={(event) => {
        const key = event.key.toLowerCase();
        if (key === "escape") {
          event.preventDefault();
          event.stopPropagation();
          dialog.close();
          return;
        }
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (key === "arrowleft" || key === "k") {
          if (multiple) showImage(index - 1);
        } else if (key === "arrowright" || key === "j") {
          if (multiple) showImage(index + 1);
        } else if (key === "+" || key === "=") {
          zoomIn();
        } else if (key === "-") {
          zoomOut();
        } else if (key === "0") {
          resetView();
        } else {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget || event.target === stageRef.current) {
          dialog.close();
        }
      }}
    >
      <button
        className="image-lightbox-close"
        type="button"
        onClick={dialog.close}
        aria-label="Close image viewer"
        title="Close (Esc)"
        aria-keyshortcuts="Escape"
      >
        <X aria-hidden="true" size={22} />
      </button>
      <div ref={stageRef} className="image-lightbox-stage">
        {loadState === "loading" ? (
          <div className="sr-only" role="status">
            Loading image…
          </div>
        ) : null}
        {loadState !== "error" ? (
          <img
            key={image.src}
            ref={imageRef}
            className={zoom === null ? "is-fit" : "is-zoomed"}
            data-loading={loadState === "loading" ? "true" : undefined}
            src={image.src}
            alt={image.alt}
            style={imageStyle}
            draggable={false}
            onLoad={() => setLoadState("loaded")}
            onError={() => setLoadState("error")}
          />
        ) : (
          <div className="image-lightbox-error" role="alert">
            <strong>Image unavailable</strong>
            <span>The source may no longer be available.</span>
            {imageUrl ? (
              <a href={imageUrl} target="_blank" rel="noopener noreferrer">
                Try the original image
                <ExternalLink aria-hidden="true" size={15} />
              </a>
            ) : null}
          </div>
        )}
      </div>
    </dialog>
  );
}
