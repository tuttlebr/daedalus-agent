import React, { useRef, useEffect, useState, useCallback } from 'react';
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

export const VirtualMessageList: React.FC<VirtualMessageListProps> = ({
  messages,
  containerHeight,
  onScroll,
}) => {
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 10 });
  const [itemHeights, setItemHeights] = useState<Map<number, number>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Default estimated height for messages
  const estimatedItemHeight = 120;
  const overscan = 3; // Number of items to render outside visible area

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
    setScrollTop(newScrollTop);
    onScroll?.(newScrollTop);
  }, [onScroll]);

  // Render only visible items
  const visibleItems: VirtualItem[] = [];
  for (let i = visibleRange.start; i <= visibleRange.end; i++) {
    if (messages[i]) {
      visibleItems.push({
        index: i,
        offset: getItemOffset(i),
        height: itemHeights.get(i) || estimatedItemHeight,
      });
    }
  }

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
};
