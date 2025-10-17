import React, { useState, useRef, useEffect, useContext } from 'react';
import { Conversation } from '@/types/chat';
import HomeContext from '@/pages/api/home/home.context';

interface SwipeableConversationsProps {
  conversations: Conversation[];
  currentConversation: Conversation | undefined;
  onSelectConversation: (conversation: Conversation) => void;
  children?: React.ReactNode;
}

export const SwipeableConversations: React.FC<SwipeableConversationsProps> = ({
  conversations,
  currentConversation,
  onSelectConversation,
  children,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [currentX, setCurrentX] = useState(0);
  const [translateX, setTranslateX] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentIndex = conversations.findIndex(c => c.id === currentConversation?.id);
  const threshold = 50; // Minimum swipe distance to trigger navigation

  useEffect(() => {
    // Add passive touch event listeners for better performance
    const container = containerRef.current;
    if (!container) return;

    const handleTouchStart = (e: TouchEvent) => {
      setIsDragging(true);
      setStartX(e.touches[0].clientX);
      setCurrentX(e.touches[0].clientX);
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!isDragging) return;
      setCurrentX(e.touches[0].clientX);
      const diff = e.touches[0].clientX - startX;
      setTranslateX(diff);
    };

    const handleTouchEnd = () => {
      if (!isDragging) return;
      setIsDragging(false);

      const diff = currentX - startX;

      if (Math.abs(diff) > threshold) {
        if (diff > 0 && currentIndex > 0) {
          // Swipe right - go to previous conversation
          onSelectConversation(conversations[currentIndex - 1]);
          triggerHapticFeedback();
        } else if (diff < 0 && currentIndex < conversations.length - 1) {
          // Swipe left - go to next conversation
          onSelectConversation(conversations[currentIndex + 1]);
          triggerHapticFeedback();
        }
      }

      // Reset position
      setTranslateX(0);
      setStartX(0);
      setCurrentX(0);
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isDragging, startX, currentX, currentIndex, conversations, onSelectConversation]);

  const triggerHapticFeedback = () => {
    // Use the Vibration API if available
    if ('vibrate' in navigator) {
      navigator.vibrate(10);
    }
  };

  return (
    <div className="relative flex-1 overflow-hidden">
      {/* Swipe indicator */}
      {conversations.length > 1 && (
        <div className="absolute top-2 left-0 right-0 z-10 flex justify-center gap-1 px-4">
          {conversations.map((conv, index) => (
            <div
              key={conv.id}
              className={`
                h-1 rounded-full transition-all duration-300
                ${index === currentIndex
                  ? 'w-6 bg-nvidia-green'
                  : 'w-1 bg-gray-300 dark:bg-gray-600'
                }
              `}
            />
          ))}
        </div>
      )}

      {/* Swipeable container */}
      <div
        ref={containerRef}
        className="h-full"
        style={{
          transform: `translateX(${translateX}px)`,
          transition: isDragging ? 'none' : 'transform 0.3s ease-out',
        }}
      >
        {/* Previous/Next hints */}
        {isDragging && (
          <>
            {currentIndex > 0 && translateX > 20 && (
              <div className="absolute left-4 top-1/2 -translate-y-1/2 z-20 animate-fade-in">
                <div className="glass text-white px-3 py-2 rounded-lg text-sm shadow-lg">
                  ← {conversations[currentIndex - 1].name}
                </div>
              </div>
            )}
            {currentIndex < conversations.length - 1 && translateX < -20 && (
              <div className="absolute right-4 top-1/2 -translate-y-1/2 z-20 animate-fade-in">
                <div className="glass text-white px-3 py-2 rounded-lg text-sm shadow-lg">
                  {conversations[currentIndex + 1].name} →
                </div>
              </div>
            )}
          </>
        )}

        {/* Content passed as children */}
        <div className="h-full">
          {children}
        </div>
      </div>

      {/* Tutorial hint on first use */}
      {conversations.length > 1 && (
        <div
          className="absolute bottom-20 left-1/2 -translate-x-1/2 pointer-events-none"
          style={{
            opacity: currentIndex === 0 ? 1 : 0,
            transition: 'opacity 2s ease-out',
          }}
        >
          <div className="bg-black/70 text-white px-4 py-2 rounded-full text-sm flex items-center gap-2">
            <span>← Swipe to navigate →</span>
          </div>
        </div>
      )}
    </div>
  );
};
