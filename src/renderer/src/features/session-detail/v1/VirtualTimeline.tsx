import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type UIEvent,
} from "react";

export const DEFAULT_INITIAL_TIMELINE_ITEMS = 20;
export const DEFAULT_OLDER_PAGE_SIZE = 80;

export interface VirtualWindowItem {
  index: number;
  offset: number;
  size: number;
}

export interface VirtualWindow {
  endIndex: number;
  items: VirtualWindowItem[];
  startIndex: number;
  totalSize: number;
}

export interface CalculateVirtualWindowOptions {
  estimatedItemHeight: number;
  itemKeys: readonly string[];
  measuredHeights?: ReadonlyMap<string, number>;
  overscan?: number;
  scrollOffset: number;
  viewportHeight: number;
}

function itemHeight(
  key: string,
  measuredHeights: ReadonlyMap<string, number> | undefined,
  estimatedItemHeight: number,
): number {
  const measured = measuredHeights?.get(key);
  return measured !== undefined && Number.isFinite(measured) && measured > 0
    ? measured
    : estimatedItemHeight;
}

function itemOffsets(
  itemKeys: readonly string[],
  measuredHeights: ReadonlyMap<string, number> | undefined,
  estimatedItemHeight: number,
): number[] {
  const offsets = new Array<number>(itemKeys.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < itemKeys.length; index += 1) {
    offsets[index + 1] =
      offsets[index] + itemHeight(itemKeys[index], measuredHeights, estimatedItemHeight);
  }
  return offsets;
}

function firstItemEndingAfter(offsets: readonly number[], target: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle + 1] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Calculates an overscanned virtual window from measured, dynamic row heights.
 * The returned end index is exclusive.
 */
export function calculateVirtualWindow({
  estimatedItemHeight,
  itemKeys,
  measuredHeights,
  overscan = 0,
  scrollOffset,
  viewportHeight,
}: CalculateVirtualWindowOptions): VirtualWindow {
  if (itemKeys.length === 0) {
    return { endIndex: 0, items: [], startIndex: 0, totalSize: 0 };
  }
  const safeEstimate =
    Number.isFinite(estimatedItemHeight) && estimatedItemHeight > 0 ? estimatedItemHeight : 120;
  const offsets = itemOffsets(itemKeys, measuredHeights, safeEstimate);
  const totalSize = offsets[offsets.length - 1];
  const safeViewport = Math.max(0, viewportHeight);
  const maxScrollOffset = Math.max(0, totalSize - safeViewport);
  const safeScrollOffset = Math.min(Math.max(0, scrollOffset), maxScrollOffset);
  const windowStart = Math.max(0, safeScrollOffset - Math.max(0, overscan));
  const windowEnd = Math.min(
    totalSize,
    safeScrollOffset + safeViewport + Math.max(0, overscan),
  );
  const startIndex = Math.min(
    itemKeys.length - 1,
    firstItemEndingAfter(offsets, windowStart),
  );
  let endIndex = startIndex;
  while (endIndex < itemKeys.length && offsets[endIndex] < windowEnd) endIndex += 1;
  if (endIndex === startIndex) endIndex = Math.min(itemKeys.length, startIndex + 1);

  const items: VirtualWindowItem[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    items.push({
      index,
      offset: offsets[index],
      size: offsets[index + 1] - offsets[index],
    });
  }
  return { endIndex, items, startIndex, totalSize };
}

function offsetForKey(
  key: string,
  itemKeys: readonly string[],
  measuredHeights: ReadonlyMap<string, number>,
  estimatedItemHeight: number,
): number | null {
  const index = itemKeys.indexOf(key);
  if (index < 0) return null;
  let offset = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    offset += itemHeight(itemKeys[cursor], measuredHeights, estimatedItemHeight);
  }
  return offset;
}

function MeasuredVirtualRow({
  children,
  itemKey,
  onHeightChange,
  style,
}: {
  children: ReactNode;
  itemKey: string;
  onHeightChange: (itemKey: string, height: number) => void;
  style: CSSProperties;
}): ReactElement {
  const rowRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => {
      const height = row.getBoundingClientRect().height;
      if (height > 0) onHeightChange(itemKey, height);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [itemKey, onHeightChange]);

  return (
    <div className="ar-v1-timeline__row" data-item-key={itemKey} ref={rowRef} style={style}>
      {children}
    </div>
  );
}

export interface LoadOlderMessagesRequest {
  limit: number;
  oldestMessageId: string | null;
}

export interface VirtualTimelineProps<Item> {
  ariaLabel?: string;
  className?: string;
  emptyState?: ReactNode;
  estimatedItemHeight?: number;
  getItemKey: (item: Item, index: number) => string;
  hasOlder?: boolean;
  initialItemCount?: number;
  isLoadingOlder?: boolean;
  items: readonly Item[];
  loadOlderLabel?: string;
  loadingOlderLabel?: string;
  olderPageSize?: number;
  onLoadOlder?: (request: LoadOlderMessagesRequest) => Promise<void> | void;
  overscan?: number;
  renderItem: (item: Item, index: number) => ReactNode;
}

interface PendingAnchor {
  distanceFromScrollTop: number;
  key: string;
}

/**
 * Bottom-anchored transcript virtualization with ResizeObserver-based dynamic
 * row measurement and scroll-anchor preservation while older rows are prepended.
 */
export function VirtualTimeline<Item>({
  ariaLabel = "Session conversation",
  className = "",
  emptyState = "No messages",
  estimatedItemHeight = 180,
  getItemKey,
  hasOlder = false,
  initialItemCount = DEFAULT_INITIAL_TIMELINE_ITEMS,
  isLoadingOlder = false,
  items,
  loadOlderLabel = "Load older messages",
  loadingOlderLabel = "Loading older messages…",
  olderPageSize = DEFAULT_OLDER_PAGE_SIZE,
  onLoadOlder,
  overscan = 360,
  renderItem,
}: VirtualTimelineProps<Item>): ReactElement {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pendingAnchorRef = useRef<PendingAnchor | null>(null);
  const loadInFlightRef = useRef(false);
  const initializedRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [measuredHeights, setMeasuredHeights] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const itemKeys = useMemo(
    () => items.map((item, index) => getItemKey(item, index)),
    [getItemKey, items],
  );
  const initialViewportHeight = Math.max(1, initialItemCount) * estimatedItemHeight;
  const [viewportHeight, setViewportHeight] = useState(initialViewportHeight);
  const [scrollOffset, setScrollOffset] = useState(
    Math.max(0, itemKeys.length * estimatedItemHeight - initialViewportHeight),
  );

  const virtualWindow = useMemo(() => {
    if (!ready) {
      const startIndex = Math.max(0, itemKeys.length - Math.max(1, initialItemCount));
      const window = calculateVirtualWindow({
        estimatedItemHeight,
        itemKeys,
        measuredHeights,
        overscan: 0,
        scrollOffset: startIndex * estimatedItemHeight,
        viewportHeight: Math.max(1, itemKeys.length - startIndex) * estimatedItemHeight,
      });
      return { ...window, startIndex };
    }
    return calculateVirtualWindow({
      estimatedItemHeight,
      itemKeys,
      measuredHeights,
      overscan,
      scrollOffset,
      viewportHeight,
    });
  }, [
    estimatedItemHeight,
    initialItemCount,
    itemKeys,
    measuredHeights,
    overscan,
    ready,
    scrollOffset,
    viewportHeight,
  ]);

  const captureAnchor = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!initializedRef.current || !scroller || itemKeys.length === 0) return;
    const anchorWindow = calculateVirtualWindow({
      estimatedItemHeight,
      itemKeys,
      measuredHeights,
      scrollOffset: scroller.scrollTop,
      viewportHeight: 1,
    });
    const anchorIndex = anchorWindow.startIndex;
    const anchorKey = itemKeys[anchorIndex];
    const anchorOffset = anchorWindow.items[0]?.offset ?? 0;
    pendingAnchorRef.current = {
      distanceFromScrollTop: anchorOffset - scroller.scrollTop,
      key: anchorKey,
    };
  }, [estimatedItemHeight, itemKeys, measuredHeights]);

  const handleHeightChange = useCallback(
    (itemKey: string, height: number) => {
      const previous = measuredHeights.get(itemKey);
      if (previous !== undefined && Math.abs(previous - height) < 0.5) return;
      captureAnchor();
      setMeasuredHeights((current) => {
        const next = new Map(current);
        next.set(itemKey, height);
        return next;
      });
    },
    [captureAnchor, measuredHeights],
  );

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (!initializedRef.current) {
      initializedRef.current = true;
      scroller.scrollTop = Math.max(0, virtualWindow.totalSize - scroller.clientHeight);
      setScrollOffset(scroller.scrollTop);
      setReady(true);
      return;
    }
    const anchor = pendingAnchorRef.current;
    if (!anchor) return;
    const nextOffset = offsetForKey(
      anchor.key,
      itemKeys,
      measuredHeights,
      estimatedItemHeight,
    );
    pendingAnchorRef.current = null;
    if (nextOffset === null) return;
    scroller.scrollTop = Math.max(0, nextOffset - anchor.distanceFromScrollTop);
    setScrollOffset(scroller.scrollTop);
  }, [estimatedItemHeight, itemKeys, measuredHeights, virtualWindow.totalSize]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = () => {
      const height = scroller.clientHeight;
      if (height > 0) setViewportHeight(height);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  const loadOlder = useCallback(() => {
    if (!hasOlder || isLoadingOlder || loadInFlightRef.current || !onLoadOlder) return;
    captureAnchor();
    loadInFlightRef.current = true;
    Promise.resolve(
      onLoadOlder({
        limit: olderPageSize,
        oldestMessageId: itemKeys[0] ?? null,
      }),
    ).finally(() => {
      loadInFlightRef.current = false;
    });
  }, [
    captureAnchor,
    hasOlder,
    isLoadingOlder,
    itemKeys,
    olderPageSize,
    onLoadOlder,
  ]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const nextOffset = event.currentTarget.scrollTop;
    setScrollOffset(nextOffset);
    if (nextOffset <= Math.min(160, estimatedItemHeight)) loadOlder();
  };

  if (items.length === 0) {
    return (
      <div
        aria-label={ariaLabel}
        className={`ar-v1-timeline ar-v1-timeline--empty ${className}`.trim()}
        role="feed"
      >
        {emptyState}
      </div>
    );
  }

  return (
    <div className={`ar-v1-timeline-shell ${className}`.trim()}>
      {hasOlder ? (
        <button
          className="ar-v1-timeline__load-older"
          data-page-size={olderPageSize}
          disabled={isLoadingOlder}
          onClick={loadOlder}
          type="button"
        >
          {isLoadingOlder ? loadingOlderLabel : loadOlderLabel}
        </button>
      ) : null}
      <div
        aria-busy={isLoadingOlder}
        aria-label={ariaLabel}
        className="ar-v1-timeline"
        data-virtual-end={virtualWindow.endIndex}
        data-virtual-start={virtualWindow.startIndex}
        onScroll={handleScroll}
        ref={scrollerRef}
        role="feed"
      >
        <div
          className="ar-v1-timeline__spacer"
          style={{ height: `${virtualWindow.totalSize}px` }}
        >
          {virtualWindow.items.map(({ index, offset }) => {
            const item = items[index];
            const key = itemKeys[index];
            return (
              <MeasuredVirtualRow
                itemKey={key}
                key={key}
                onHeightChange={handleHeightChange}
                style={{ transform: `translate3d(0, ${offset}px, 0)` }}
              >
                {renderItem(item, index)}
              </MeasuredVirtualRow>
            );
          })}
        </div>
      </div>
    </div>
  );
}
