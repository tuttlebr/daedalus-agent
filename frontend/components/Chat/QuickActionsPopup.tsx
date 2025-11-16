import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { IconPlus, IconX, IconPaperclip, IconCamera, /* IconMicrophone, */ IconBrain } from '@tabler/icons-react'; // Microphone icon commented out - Voice recording disabled

interface QuickActionsPopupProps {
  onAttachFile: () => void;
  onTakePhoto: () => void;
  onToggleDeepThought: () => void;
  isDeepThoughtEnabled: boolean;
  className?: string;
}

export const QuickActionsPopup: React.FC<QuickActionsPopupProps> = ({
  onAttachFile,
  onTakePhoto,
  onToggleDeepThought,
  isDeepThoughtEnabled,
  className = '',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [popupPosition, setPopupPosition] = useState({ top: 0, left: 0, positionAbove: true });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);

  const actions = [
    {
      id: 'attach',
      icon: <IconPaperclip size={24} />,
      onClick: () => {
        onAttachFile();
        setIsOpen(false);
      },
    },
    {
      id: 'camera',
      icon: <IconCamera size={24} />,
      onClick: () => {
        onTakePhoto();
        setIsOpen(false);
      },
    },
    {
      id: 'deep-thought',
      icon: <IconBrain size={24} />,
      onClick: () => {
        onToggleDeepThought();
      },
      isToggle: true,
      isActive: isDeepThoughtEnabled,
    },
  ];

  // Handle escape key to close popup
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen]);

  // Prevent body scroll when popup is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // Mount check for portal
  useEffect(() => {
    setMounted(true);
  }, []);

  // Calculate popup position when opened
  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const popupHeight = 100; // Approximate height of popup
      const spacing = 12;
      const viewportHeight = window.innerHeight;

      // Check if there's enough space above the button
      const spaceAbove = rect.top;
      const spaceBelow = viewportHeight - rect.bottom;
      const positionAbove = spaceAbove >= popupHeight || spaceAbove >= spaceBelow;

      if (positionAbove) {
        // Position above the button
        setPopupPosition({
          top: rect.top - spacing,
          left: rect.left,
          positionAbove: true,
        });
      } else {
        // Position below the button
        setPopupPosition({
          top: rect.bottom + spacing,
          left: rect.left,
          positionAbove: false,
        });
      }
    }
  }, [isOpen]);

  return (
    <>
      {/* Main + Button - ≥44×44px touch target */}
      <button
        ref={buttonRef}
        onClick={(e) => {
          // Haptic feedback (if supported)
          if ('vibrate' in navigator) {
            navigator.vibrate(10);
          }
          setIsOpen(!isOpen);
        }}
        className={`
          relative flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full
          liquid-glass liquid-glass-subtle transition-all duration-300 active:scale-95
          text-neutral-700 hover:text-nvidia-green
          dark:text-white/80 dark:hover:text-nvidia-green
          ${isOpen ? 'z-[60] liquid-glass-medium' : 'z-20'}
          ${className}
        `}
        aria-label={isOpen ? "Close quick actions" : "Quick actions"}
        aria-expanded={isOpen}
      >
        <IconPlus size={24} className={`transition-transform duration-200 ${isOpen ? 'rotate-45' : ''}`} />
      </button>

      {/* Overlay and Popup Menu - rendered via portal */}
      {mounted && isOpen && createPortal(
        <>
          {/* Overlay */}
          <div
            className="fixed inset-0 z-[9998] backdrop-blur-sm animate-fade-in"
            onClick={() => setIsOpen(false)}
            aria-hidden="true"
          />

          {/* Popup Menu */}
          <div
            className={`
              fixed z-[9999]
              rounded-2xl liquid-glass liquid-glass-strong
              ${popupPosition.positionAbove ? 'animate-slide-up-glass origin-bottom-left' : 'animate-slide-down origin-top-left'}
              min-w-[240px]
            `}
            style={{
              top: `${popupPosition.top}px`,
              left: `${popupPosition.left}px`,
              transform: popupPosition.positionAbove ? 'translateY(-100%)' : 'translateY(0)',
            }}
            role="menu"
            aria-orientation="horizontal"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            <div className="grid grid-cols-3 gap-2 p-3">
              {actions.map((action, index) => (
                <button
                  key={action.id}
                  onClick={(e) => {
                    // Haptic feedback (if supported)
                    if ('vibrate' in navigator) {
                      navigator.vibrate(10);
                    }
                    action.onClick();
                  }}
                  className={`
                    relative flex items-center justify-center rounded-xl p-2 min-h-[44px] min-w-[44px]
                    liquid-glass liquid-glass-subtle transition-all duration-300 active:scale-95
                    ${action.isActive ? 'liquid-glass-medium' : ''}
                  `}
                  role="menuitem"
                  aria-label={action.id === 'attach' ? 'Attach file' : action.id === 'camera' ? 'Take photo' : 'Toggle deep thought'}
                >
                  <div
                    className={`
                      flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full
                      transition-all duration-200
                      ${action.isActive
                        ? 'bg-nvidia-green text-white shadow-[0_0_15px_rgba(118,185,0,0.5)]'
                        : 'bg-white/20 text-neutral-700 dark:bg-white/10 dark:text-white/90 hover:bg-white/30 dark:hover:bg-white/20'
                      }
                    `}
                  >
                    {action.icon}
                  </div>
                  {action.isToggle && (
                    <div
                      className={`
                        absolute top-0 right-0 h-2.5 w-2.5 rounded-full transition-colors
                        ${action.isActive ? 'bg-nvidia-green shadow-[0_0_8px_rgba(118,185,0,0.8)]' : 'bg-white/40 dark:bg-white/30'}
                      `}
                    />
                  )}
                </button>
              ))}
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  );
};
