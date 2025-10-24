import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Message } from '@/types/chat';
import { MemoizedChatMessage } from './MemoizedChatMessage';

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

  // Default estimated height for messages - larger for mobile
  const estimatedItemHeight = window.innerWidth <= 768 ? 150 : 120;
  const overscan = window.innerWidth <= 768 ? 2 : 3; // Less overscan on mobile for memory

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

  // Measure item heights after render
  useEffect(() => {
    const newHeights = new Map(itemHeights);
    let hasChanges = false;

    itemRefs.current.forEach((element, index) => {
      if (element) {
        const height = element.getBoundingClientRect().height;
        if (height !== itemHeights.get(index)) {
          newHeights.set(index, height);
          hasChanges = true;
        }
      }
    });

    if (hasChanges) {
      setItemHeights(newHeights);
    }
  }, [visibleRange, messages]);

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

    // Debounce scroll updates for better performance
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    scrollTimeoutRef.current = setTimeout(() => {
      setScrollTop(newScrollTop);
      onScroll?.(newScrollTop);
    }, 16); // ~60fps
  }, [onScroll]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
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
        {visibleItems.map((item) => (
          <div
            key={messages[item.index].id || item.index}
            ref={(el) => {
              if (el) itemRefs.current.set(item.index, el);
              else itemRefs.current.delete(item.index);
            }}
            style={{
              position: 'absolute',
              top: item.offset,
              left: 0,
              right: 0,
              minHeight: estimatedItemHeight,
            }}
          >
            <MemoizedChatMessage
              message={messages[item.index]}
              messageIndex={item.index}
            />
          </div>
        ))}
      </div>
    </div>
  );
});

VirtualMessageList.displayName = 'VirtualMessageList';
