import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Message } from '@/types/chat';
import { MemoizedChatMessage } from './MemoizedChatMessage';
import { revokeImageBlob } from '@/utils/app/imageHandler';

interface VirtualMessageListProps {
  messages: Message[];
  containerHeight: number;
  onScroll?: (scrollTop: number) => void;
}

interface VirtualItem {
  index: number;
  offset: number;
  height: number;
}

// Height cache with WeakMap for better memory management
const globalHeightCache = new WeakMap<Message, number>();

export const VirtualMessageList: React.FC<VirtualMessageListProps> = React.memo(({
  messages,
  containerHeight,
  onScroll,
}) => {
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 10 });
  const [itemHeights, setItemHeights] = useState<Map<number, number>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const rafRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const imageObserverRef = useRef<IntersectionObserver | null>(null);
  const trackedImages = useRef<Map<string, string[]>>(new Map()); // messageId -> imageIds

  // Use WeakMap for caching heights by message object
  const messageHeightCache = useRef(globalHeightCache);

  // Default estimated height for messages - larger for mobile
  const estimatedItemHeight = window.innerWidth <= 768 ? 150 : 120;
  const overscan = window.innerWidth <= 768 ? 1 : 2; // Reduced overscan for better memory management
  const isMobile = window.innerWidth <= 768;

  // Clear height cache when messages change significantly
  useEffect(() => {
    // Clear the WeakMap cache for new messages
    messages.forEach((message, index) => {
      if (index >= messages.length - 2) {
        // Clear cache for last few messages as they might be new/updated
        messageHeightCache.current.delete(message);
      }
    });
  }, [messages.length]);

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

  // Calculate total height
  const getTotalHeight = useCallback(() => {
    let totalHeight = 0;
    for (let i = 0; i < messages.length; i++) {
      totalHeight += itemHeights.get(i) || estimatedItemHeight;
    }
    return totalHeight;
  }, [messages.length, itemHeights, estimatedItemHeight]);

  // Calculate which items are visible
  const calculateVisibleRange = useCallback(() => {
    let accumulatedHeight = 0;
    let startIndex = 0;
    let endIndex = messages.length - 1;

    // Find start index
    for (let i = 0; i < messages.length; i++) {
      const itemHeight = itemHeights.get(i) || estimatedItemHeight;
      if (accumulatedHeight + itemHeight > scrollTop) {
        startIndex = Math.max(0, i - overscan);
        break;
      }
      accumulatedHeight += itemHeight;
    }

    // Find end index
    accumulatedHeight = 0;
    for (let i = startIndex; i < messages.length; i++) {
      if (accumulatedHeight > scrollTop + containerHeight) {
        endIndex = Math.min(messages.length - 1, i + overscan);
        break;
      }
      const itemHeight = itemHeights.get(i) || estimatedItemHeight;
      accumulatedHeight += itemHeight;
    }

    return { start: startIndex, end: endIndex };
  }, [messages.length, scrollTop, containerHeight, itemHeights, estimatedItemHeight, overscan]);

  // Update visible range when scroll changes
  useEffect(() => {
    const newRange = calculateVisibleRange();
    setVisibleRange(newRange);
  }, [calculateVisibleRange]);

  // Measure item heights after render with WeakMap caching
  useEffect(() => {
    // Use a small delay to ensure content is rendered (especially images)
    const measureTimeout = setTimeout(() => {
      const newHeights = new Map(itemHeights);
      let hasChanges = false;

      itemRefs.current.forEach((element, index) => {
        if (element && messages[index]) {
          const message = messages[index];

          // Always measure actual height to handle dynamic content
          const height = element.getBoundingClientRect().height;

          // Add a minimum height to prevent zero-height items
          const actualHeight = Math.max(height, 60); // At least 60px

          if (actualHeight !== itemHeights.get(index)) {
            newHeights.set(index, actualHeight);
            // Update cache only if height is reasonable
            if (actualHeight > 60) {
              messageHeightCache.current.set(message, actualHeight);
            }
            hasChanges = true;
          }
        }
      });

      if (hasChanges) {
        setItemHeights(newHeights);
      }
    }, 100); // Small delay to allow content to render

    return () => clearTimeout(measureTimeout);
  }, [visibleRange, messages, itemHeights]);

  // Calculate offset for each visible item
  const getItemOffset = useCallback((index: number) => {
    let offset = 0;
    for (let i = 0; i < index; i++) {
      offset += itemHeights.get(i) || estimatedItemHeight;
    }
    return offset;
  }, [itemHeights, estimatedItemHeight]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const newScrollTop = e.currentTarget.scrollTop;

    // Cancel pending updates
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }

    // Use requestAnimationFrame for smooth updates
    rafRef.current = requestAnimationFrame(() => {
      setScrollTop(newScrollTop);
      onScroll?.(newScrollTop);
      rafRef.current = null;
    });
  }, [onScroll]);

  // Setup ResizeObserver to handle dynamic content changes
  useEffect(() => {
    if (!resizeObserverRef.current) {
      resizeObserverRef.current = new ResizeObserver((entries) => {
        const newHeights = new Map(itemHeights);
        let hasChanges = false;

        entries.forEach((entry) => {
          const element = entry.target as HTMLDivElement;
          const index = Array.from(itemRefs.current.entries())
            .find(([_, el]) => el === element)?.[0];

          if (index !== undefined) {
            const height = entry.contentRect.height;
            const actualHeight = Math.max(height, 60);

            if (actualHeight !== itemHeights.get(index)) {
              newHeights.set(index, actualHeight);
              hasChanges = true;
            }
          }
        });

        if (hasChanges) {
          setItemHeights(newHeights);
        }
      });
    }

    // Observe all visible items
    itemRefs.current.forEach((element) => {
      resizeObserverRef.current?.observe(element);
    });

    return () => {
      resizeObserverRef.current?.disconnect();
    };
  }, [visibleRange, itemHeights]);

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
                  console.log(`Revoking ${imageIds.length} image blobs for message ${messageId}`);
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
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
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
  const visibleItems = useMemo(() => {
    const items: VirtualItem[] = [];
    for (let i = visibleRange.start; i <= visibleRange.end; i++) {
      if (messages[i]) {
        items.push({
          index: i,
          offset: getItemOffset(i),
          height: itemHeights.get(i) || estimatedItemHeight,
        });
      }
    }
    return items;
  }, [visibleRange, messages, getItemOffset, itemHeights, estimatedItemHeight]);

  return (
    <div
      ref={containerRef}
      className="relative overflow-y-auto momentum-scroll"
      style={{ height: containerHeight }}
      onScroll={handleScroll}
    >
      {/* Total height container */}
      <div style={{ height: getTotalHeight() }}>
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
                willChange: visibleRange.start <= item.index && item.index <= visibleRange.start + 2 ? 'transform' : 'auto',
              }}
            >
              <MemoizedChatMessage
                message={message}
                messageIndex={item.index}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});

VirtualMessageList.displayName = 'VirtualMessageList';
