import React, { useRef, useEffect, useState, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import { Message } from '@/types/chat';
import { MemoizedChatMessage } from './MemoizedChatMessage';
import { revokeImageBlob } from '@/utils/app/imageHandler';
import { Logger } from '@/utils/logger';

const logger = new Logger('VirtualMessageList');

interface VirtualMessageListProps {
  messages: Message[];
  containerHeight: number;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  onRetry?: (message: Message) => void;
}

interface VirtualItem {
  index: number;
  offset: number;
  height: number;
}

// Height cache with WeakMap for better memory management
const globalHeightCache = new WeakMap<Message, number>();

export const VirtualMessageList = forwardRef<HTMLDivElement, VirtualMessageListProps>(({
  messages,
  containerHeight,
  onScroll,
  onRetry,
}, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => containerRef.current!);

  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 10 });
  // Heights stored in a ref to avoid re-render cascades from circular state dependencies.
  // Three effects previously all depended on AND set itemHeights state, causing loops where
  // height changes → re-render → new measurements → height changes → scroll container shrinks → snap.
  const itemHeightsRef = useRef<Map<number, number>>(new Map());
  // Incremented when heights change to force re-render with updated item positions
  const [renderTick, setRenderTick] = useState(0);
  const scrollTopRef = useRef(0);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const rafRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const imageObserverRef = useRef<IntersectionObserver | null>(null);
  const trackedImages = useRef<Map<string, string[]>>(new Map());

  // Use WeakMap for caching heights by message object
  const messageHeightCache = useRef(globalHeightCache);

  // Default estimated height for messages - larger for mobile
  const estimatedItemHeight = window.innerWidth <= 768 ? 150 : 120;
  const overscan = 5;
  const isMobile = window.innerWidth <= 768;

  // Seed heights from cache when messages change (no itemHeights dep - reads from ref)
  useEffect(() => {
    const heights = itemHeightsRef.current;

    // Drop stale indexes if messages were removed
    for (const index of heights.keys()) {
      if (index >= messages.length) {
        heights.delete(index);
      }
    }

    // Clear cached heights for the most recent messages (they change during streaming)
    messages.forEach((message, index) => {
      if (index >= messages.length - 2) {
        messageHeightCache.current.delete(message);
      }
      // Seed heights from cache to improve offscreen estimates
      if (!heights.has(index)) {
        const cachedHeight = messageHeightCache.current.get(message);
        if (cachedHeight) {
          heights.set(index, cachedHeight);
        }
      }
    });
  }, [messages.length, messages]);

  // Extract image references from messages
  const extractImageReferences = useCallback((message: Message): string[] => {
    const imageIds: string[] = [];

    // Check attachments
    if (message.attachments) {
      message.attachments.forEach(att => {
        if (att.type === 'image' && att.imageRef?.imageId) {
          imageIds.push(att.imageRef.imageId);
        }
      });
    }

    // Check content for image references (Redis storage URLs)
    const imageRegex = /\/api\/session\/imageStorage\?imageId=([^&\s"']+)/g;
    let match;
    while ((match = imageRegex.exec(message.content)) !== null) {
      imageIds.push(match[1]);
    }

    return imageIds;
  }, []);

  // Height helpers - always read from the ref so values are current
  const getItemHeight = useCallback((index: number) => {
    const measured = itemHeightsRef.current.get(index);
    if (measured) return measured;
    const message = messages[index];
    return (message ? messageHeightCache.current.get(message) : undefined) || estimatedItemHeight;
  }, [messages, estimatedItemHeight]);

  const getItemOffset = useCallback((index: number) => {
    let offset = 0;
    for (let i = 0; i < index; i++) {
      offset += getItemHeight(i);
    }
    return offset;
  }, [getItemHeight]);

  const getTotalHeight = useCallback(() => {
    let totalHeight = 0;
    for (let i = 0; i < messages.length; i++) {
      totalHeight += getItemHeight(i);
    }
    return totalHeight;
  }, [messages.length, getItemHeight]);

  // Calculate which items are visible from current scroll position
  const computeVisibleRange = useCallback(() => {
    const st = scrollTopRef.current;
    let startIndex = 0;
    let endIndex = messages.length - 1;

    // Find start index
    let accumulatedHeight = 0;
    for (let i = 0; i < messages.length; i++) {
      const itemHeight = getItemHeight(i);
      if (accumulatedHeight + itemHeight > st) {
        startIndex = Math.max(0, i - overscan);
        break;
      }
      accumulatedHeight += itemHeight;
    }

    // Find end index using absolute offset to avoid rendering all items below start
    let endOffset = getItemOffset(startIndex);
    for (let i = startIndex; i < messages.length; i++) {
      if (endOffset > st + containerHeight) {
        endIndex = Math.min(messages.length - 1, i + overscan);
        break;
      }
      endOffset += getItemHeight(i);
    }

    return { start: startIndex, end: endIndex };
  }, [messages.length, containerHeight, getItemHeight, getItemOffset, overscan]);

  // Recompute visible range when messages or container change
  useEffect(() => {
    const range = computeVisibleRange();
    setVisibleRange(range);
  }, [computeVisibleRange]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const newScrollTop = e.currentTarget.scrollTop;
    scrollTopRef.current = newScrollTop;

    // Call parent onScroll handler if provided
    if (onScroll) {
      onScroll(e);
    }

    // Cancel pending updates
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }

    // Use requestAnimationFrame for smooth updates
    rafRef.current = requestAnimationFrame(() => {
      const range = computeVisibleRange();
      setVisibleRange(prev => {
        if (prev.start === range.start && prev.end === range.end) return prev;
        return range;
      });
      rafRef.current = null;
    });
  }, [onScroll, computeVisibleRange]);

  // Measure item heights after render and anchor scroll position to prevent jumps.
  // No itemHeights dep - reads/writes the ref directly, breaking the circular chain.
  useEffect(() => {
    const measureTimeout = setTimeout(() => {
      const heights = itemHeightsRef.current;
      let hasChanges = false;

      // Record the offset of the first visible item BEFORE changing heights
      const firstVisible = visibleRange.start;
      const oldFirstVisibleOffset = getItemOffset(firstVisible);

      itemRefs.current.forEach((element, index) => {
        if (element && messages[index]) {
          const message = messages[index];

          // Always measure actual height to handle dynamic content
          const height = element.getBoundingClientRect().height;

          // Round to prevent subpixel oscillation and enforce minimum
          const actualHeight = Math.max(Math.round(height), 60);

          if (actualHeight !== heights.get(index)) {
            heights.set(index, actualHeight);
            // Update cache only if height is reasonable
            if (actualHeight > 60) {
              messageHeightCache.current.set(message, actualHeight);
            }
            hasChanges = true;
          }
        }
      });

      if (hasChanges) {
        // Anchor scroll position: compensate for height changes above the viewport
        // so the user's view stays in place instead of snapping
        const newFirstVisibleOffset = getItemOffset(firstVisible);
        const delta = newFirstVisibleOffset - oldFirstVisibleOffset;
        const container = containerRef.current;
        if (delta !== 0 && container) {
          container.scrollTop += delta;
          scrollTopRef.current = container.scrollTop;
        }

        // Recompute visible range with updated heights
        const range = computeVisibleRange();
        setVisibleRange(prev => {
          if (prev.start === range.start && prev.end === range.end) {
            // Range unchanged but item positions shifted - force render update
            setRenderTick(t => t + 1);
            return prev;
          }
          return range;
        });
      }
    }, 50);

    return () => clearTimeout(measureTimeout);
  }, [visibleRange, messages, getItemOffset, computeVisibleRange]);

  // ResizeObserver for dynamic content changes (no itemHeights dep)
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const heights = itemHeightsRef.current;
      let hasChanges = false;

      entries.forEach((entry) => {
        const element = entry.target as HTMLDivElement;
        const found = Array.from(itemRefs.current.entries())
          .find(([_, el]) => el === element);

        if (found) {
          const [index] = found;
          const h = Math.max(Math.round(entry.contentRect.height), 60);

          if (h !== heights.get(index)) {
            heights.set(index, h);
            hasChanges = true;
          }
        }
      });

      if (hasChanges) {
        const range = computeVisibleRange();
        setVisibleRange(prev => {
          if (prev.start === range.start && prev.end === range.end) {
            setRenderTick(t => t + 1);
            return prev;
          }
          return range;
        });
      }
    });

    resizeObserverRef.current = observer;

    // Observe all visible items
    itemRefs.current.forEach((element) => {
      observer.observe(element);
    });

    return () => {
      observer.disconnect();
    };
  }, [visibleRange, computeVisibleRange]);

  // Set up IntersectionObserver for image tracking
  useEffect(() => {
    if (!imageObserverRef.current) {
      imageObserverRef.current = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          const element = entry.target as HTMLDivElement;
          const messageId = element.getAttribute('data-message-id');

          if (messageId) {
            if (!entry.isIntersecting) {
              // Message is no longer visible - schedule image blob revocation
              // Use a delay to avoid race conditions with image loading
              setTimeout(() => {
                // Double-check if still not intersecting (user might have scrolled back)
                if (!element.isConnected || !imageObserverRef.current) return;

                const imageIds = trackedImages.current.get(messageId);
                if (imageIds && imageIds.length > 0) {
                  logger.info(`Revoking ${imageIds.length} image blobs for message ${messageId}`);
                  imageIds.forEach(imageId => {
                    revokeImageBlob(imageId);
                  });
                  trackedImages.current.delete(messageId);
                }
              }, 1000); // 1 second delay to ensure images have time to load
            }
          }
        });
      }, {
        root: containerRef.current,
        rootMargin: isMobile ? '200px' : '400px', // Larger buffer to keep images loaded longer
        threshold: 0
      });
    }

    return () => {
      imageObserverRef.current?.disconnect();
    };
  }, [isMobile]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
      if (imageObserverRef.current) {
        imageObserverRef.current.disconnect();
        imageObserverRef.current = null;
      }
      // Clear all tracked image blobs
      trackedImages.current.forEach((imageIds) => {
        imageIds.forEach(imageId => {
          revokeImageBlob(imageId);
        });
      });
      trackedImages.current.clear();
      // Clear item refs to prevent memory leaks
      itemRefs.current.clear();
    };
  }, []);

  // Render only visible items
  // renderTick in deps forces recalculation when heights change (since getItemOffset/getItemHeight
  // read from a ref, their callback identity doesn't change with height updates)
  const visibleItems = useMemo(() => {
    const items: VirtualItem[] = [];
    for (let i = visibleRange.start; i <= visibleRange.end; i++) {
      if (messages[i]) {
        items.push({
          index: i,
          offset: getItemOffset(i),
          height: getItemHeight(i),
        });
      }
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRange, messages, getItemOffset, getItemHeight, renderTick]);

  const totalHeight = getTotalHeight();

  return (
    <div
      ref={containerRef}
      className="relative overflow-y-auto momentum-scroll"
      style={{
        height: '100%',
        // Disable browser scroll anchoring - we handle it manually in the measurement effect
        overflowAnchor: 'none',
        scrollBehavior: 'auto',
      }}
      onScroll={handleScroll}
    >
      {/* Total height container */}
      <div style={{ height: Math.max(totalHeight, containerHeight), position: 'relative' }}>
        {/* Rendered items */}
        {visibleItems.map((item) => {
          const message = messages[item.index];
          const messageId = message.id || `msg-${item.index}`;
          const imageIds = extractImageReferences(message);

          return (
            <div
              key={messageId}
              ref={(el) => {
                if (el) {
                  itemRefs.current.set(item.index, el);

                  // Track and observe messages with images
                  if (imageIds.length > 0) {
                    trackedImages.current.set(messageId, imageIds);
                    imageObserverRef.current?.observe(el);
                  }
                } else {
                  const existingEl = itemRefs.current.get(item.index);
                  if (existingEl && imageObserverRef.current) {
                    imageObserverRef.current.unobserve(existingEl);
                  }
                  itemRefs.current.delete(item.index);

                  // Cleanup tracked images when unmounting
                  const trackedIds = trackedImages.current.get(messageId);
                  if (trackedIds) {
                    trackedIds.forEach(id => revokeImageBlob(id));
                    trackedImages.current.delete(messageId);
                  }
                }
              }}
              data-message-id={messageId}
              style={{
                position: 'absolute',
                top: item.offset,
                left: 0,
                right: 0,
                minHeight: estimatedItemHeight,
                contain: 'layout style paint',
                overflowAnchor: 'none',
              }}
            >
              <MemoizedChatMessage
                message={message}
                messageIndex={item.index}
                onRetry={onRetry ? () => onRetry(message) : undefined}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});

VirtualMessageList.displayName = 'VirtualMessageList';
