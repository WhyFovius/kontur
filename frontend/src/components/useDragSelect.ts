import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

export interface ThumbRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CommitMeta {
  /** A plain tap/click on the already-selected option (consumers may toggle off). */
  tappedSelected: boolean;
  /** The pointer actually travelled / the preview changed during the press. */
  viaDrag: boolean;
}

interface DragSelectOptions<T extends string> {
  values: readonly T[];
  selected: T | null;
  axis: "x" | "y";
  /** Touch drags are opt-in: vertical lists keep touch scrolling and use taps. */
  allowTouch?: boolean;
  onCommit: (value: T, meta: CommitMeta) => void;
}

/**
 * Press-and-drag selection shared by the segmented filter, the workspace
 * navigation, the mobile nav and the donut legend.
 *
 * Pressing captures the pointer; the thumb rect then *interpolates*
 * between neighbouring items while the pointer travels (the consuming
 * motion.span springs after it), and releasing commits the option under
 * the pointer. A plain click without travel behaves like a normal button,
 * keyboard clicks (detail === 0) always reach onCommit untouched.
 */
export function useDragSelect<T extends string>({
  values,
  selected,
  axis,
  allowTouch = false,
  onCommit,
}: DragSelectOptions<T>) {
  const containerEl = useRef<HTMLElement | null>(null);
  const items = useRef(new Map<T, HTMLElement>());
  const callbackCache = useRef(new Map<T, (el: HTMLElement | null) => void>());

  const [preview, setPreview] = useState<T | null>(null);
  const [thumbRect, setThumbRect] = useState<ThumbRect | null>(null);
  const [dragging, setDragging] = useState(false);

  const draggingRef = useRef(false);
  const startSelectedRef = useRef<T | null>(selected);
  const movedRef = useRef(false);
  const downPosRef = useRef(0);
  const suppressClickRef = useRef(false);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const setContainer = useCallback((el: HTMLElement | null) => {
    containerEl.current = el;
  }, []);

  const registerItem = useCallback((value: T) => {
    let callback = callbackCache.current.get(value);
    if (!callback) {
      callback = (el: HTMLElement | null) => {
        if (el) items.current.set(value, el);
        else items.current.delete(value);
      };
      callbackCache.current.set(value, callback);
    }
    return callback;
  }, []);

  const measureAll = useCallback((): { value: T; rect: ThumbRect; center: number }[] => {
    const container = containerEl.current;
    if (!container) return [];
    const base = container.getBoundingClientRect();
    const measured: { value: T; rect: ThumbRect; center: number }[] = [];
    for (const value of values) {
      const el = items.current.get(value);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const rect: ThumbRect = {
        x: r.left - base.left - container.clientLeft,
        y: r.top - base.top - container.clientTop,
        w: r.width,
        h: r.height,
      };
      measured.push({
        value,
        rect,
        center: axis === "x" ? rect.x + rect.w / 2 : rect.y + rect.h / 2,
      });
    }
    return measured;
  }, [values, axis]);

  const syncTo = useCallback(
    (value: T | null) => {
      if (value == null) return;
      const found = measureAll().find((entry) => entry.value === value);
      if (found) setThumbRect(found.rect);
    },
    [measureAll],
  );

  // Keep the thumb glued to the selected item outside of drags.
  useLayoutEffect(() => {
    if (!draggingRef.current) syncTo(selectedRef.current);
  }, [selected, syncTo]);

  useEffect(() => {
    const container = containerEl.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!draggingRef.current) syncTo(selectedRef.current);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [syncTo]);

  const pointerPos = (event: ReactPointerEvent): number => {
    const container = containerEl.current;
    if (!container) return 0;
    const base = container.getBoundingClientRect();
    return axis === "x"
      ? event.clientX - base.left - container.clientLeft
      : event.clientY - base.top - container.clientTop;
  };

  const stateAt = (pos: number): { value: T; rect: ThumbRect } | null => {
    const measured = measureAll();
    if (measured.length === 0) return null;
    let nearest = measured[0];
    for (const entry of measured) {
      if (Math.abs(entry.center - pos) < Math.abs(nearest.center - pos)) nearest = entry;
    }
    // Interpolate the thumb between the centres it travels between.
    let rect = nearest.rect;
    for (let i = 0; i < measured.length - 1; i += 1) {
      const a = measured[i];
      const b = measured[i + 1];
      if (pos >= a.center && pos <= b.center) {
        const span = b.center - a.center || 1;
        const t = (pos - a.center) / span;
        rect = {
          x: a.rect.x + (b.rect.x - a.rect.x) * t,
          y: a.rect.y + (b.rect.y - a.rect.y) * t,
          w: a.rect.w + (b.rect.w - a.rect.w) * t,
          h: a.rect.h + (b.rect.h - a.rect.h) * t,
        };
        break;
      }
    }
    return { value: nearest.value, rect };
  };

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (event.pointerType === "touch" && !allowTouch) return;
    const container = containerEl.current;
    if (!container) return;
    try {
      container.setPointerCapture(event.pointerId);
    } catch {
      /* capture is a progressive enhancement */
    }
    const pos = pointerPos(event);
    const at = stateAt(pos);
    if (!at) return;
    draggingRef.current = true;
    movedRef.current = false;
    downPosRef.current = pos;
    startSelectedRef.current = selectedRef.current;
    setDragging(true);
    setPreview(at.value);
    setThumbRect(at.rect);
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    if (!draggingRef.current) return;
    const pos = pointerPos(event);
    const at = stateAt(pos);
    if (!at) return;
    if (Math.abs(pos - downPosRef.current) > 6 || at.value !== startSelectedRef.current) {
      movedRef.current = true;
    }
    setPreview(at.value);
    setThumbRect(at.rect);
  };

  const endDrag = (event: ReactPointerEvent, commit: boolean) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    const at = stateAt(pointerPos(event));
    if (commit && at) {
      suppressClickRef.current = true;
      commitRef.current(at.value, {
        tappedSelected: !movedRef.current && at.value === startSelectedRef.current,
        viaDrag: movedRef.current,
      });
      // Snap the thumb exactly onto the committed item (springs do the rest).
      const snapped = measureAll().find((entry) => entry.value === at.value);
      if (snapped) setThumbRect(snapped.rect);
    } else {
      syncTo(selectedRef.current);
    }
    setPreview(null);
  };

  const onPointerUp = (event: ReactPointerEvent) => endDrag(event, true);
  const onPointerCancel = (event: ReactPointerEvent) => endDrag(event, false);

  /** Click handler for items: mouse clicks after a drag are swallowed once. */
  const handleItemClick = useCallback(
    (value: T, event: ReactMouseEvent) => {
      event.preventDefault();
      if (suppressClickRef.current && event.detail !== 0) {
        suppressClickRef.current = false;
        return;
      }
      suppressClickRef.current = false;
      commitRef.current(value, {
        tappedSelected: value === selectedRef.current,
        viaDrag: false,
      });
    },
    [],
  );

  return {
    containerRef: setContainer,
    containerHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    registerItem,
    thumbRect,
    dragging,
    /** What the thumb/highlight should show right now. */
    active: preview ?? selected,
    handleItemClick,
  };
}
