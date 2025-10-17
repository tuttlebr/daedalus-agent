import React, { useState } from 'react';
import {
  IconPlus,
  IconMessage,
  IconBrain,
  IconPaperclip,
  IconX,
} from '@tabler/icons-react';

interface FABAction {
  id: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  color?: string;
}

interface FloatingActionButtonProps {
  actions?: FABAction[];
  onNewChat: () => void;
  onNewDeepThought?: () => void;
}

export const FloatingActionButton: React.FC<FloatingActionButtonProps> = ({
  actions,
  onNewChat,
  onNewDeepThought,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const defaultActions: FABAction[] = actions || [
    {
      id: 'new-chat',
      icon: <IconMessage size={20} />,
      label: 'New Chat',
      onClick: () => {
        onNewChat();
        setIsExpanded(false);
      },
    },
    {
      id: 'deep-thought',
      icon: <IconBrain size={20} />,
      label: 'Deep Thought',
      onClick: () => {
        onNewDeepThought?.();
        setIsExpanded(false);
      },
      color: 'bg-purple-500',
    },
  ];

  const toggleExpanded = () => {
    setIsExpanded(!isExpanded);
    // Haptic feedback
    if ('vibrate' in navigator) {
      navigator.vibrate(10);
    }
  };

  return (
    <>
      {/* Backdrop */}
      {isExpanded && (
        <div
          className="fixed inset-0 bg-black/20 z-30 md:hidden"
          onClick={() => setIsExpanded(false)}
        />
      )}

      {/* FAB Container */}
      <div className="fixed bottom-20 right-4 z-[55] md:hidden">
        {/* Speed dial actions */}
        <div
          className={`
            absolute bottom-16 right-0 flex flex-col items-end gap-3
            transition-all duration-300 ease-out origin-bottom-right
            ${isExpanded
              ? 'opacity-100 scale-100 pointer-events-auto'
              : 'opacity-0 scale-95 pointer-events-none'
            }
          `}
        >
          {defaultActions.map((action, index) => (
            <div
              key={action.id}
              className="flex items-center gap-3"
              style={{
                transitionDelay: isExpanded ? `${index * 50}ms` : '0ms',
              }}
            >
              {/* Label */}
              <span className="glass text-white px-3 py-1.5 rounded-lg text-sm whitespace-nowrap shadow-lg animate-slide-in">
                {action.label}
              </span>

              {/* Mini FAB */}
              <button
                onClick={action.onClick}
                className={`
                  w-12 h-12 rounded-full shadow-lg glass
                  flex items-center justify-center
                  text-white transition-all duration-200
                  hover:scale-110 active:scale-95
                  hover:shadow-glow-green
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2
                  ${action.color || 'bg-nvidia-green'}
                `}
                aria-label={action.label}
              >
                {action.icon}
              </button>
            </div>
          ))}
        </div>

        {/* Main FAB */}
        <button
          onClick={toggleExpanded}
          className={`
            relative w-14 h-14 rounded-full shadow-xl
            flex items-center justify-center
            text-white transition-all duration-300
            hover:scale-110 active:scale-95
            focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2
            ${isExpanded
              ? 'bg-gray-700 rotate-45'
              : 'bg-nvidia-green rotate-0'
            }
          `}
          aria-label={isExpanded ? 'Close menu' : 'Open menu'}
          aria-expanded={isExpanded}
        >
          {isExpanded ? <IconX size={24} /> : <IconPlus size={24} />}

          {/* Pulse animation when closed */}
          {!isExpanded && (
            <span className="absolute inset-0 rounded-full bg-nvidia-green animate-ping opacity-20" />
          )}
        </button>
      </div>
    </>
  );
};
