import React, { useState, useEffect } from 'react';
import { IconPlus, IconX, IconPaperclip, IconCamera, IconMicrophone, IconBrain } from '@tabler/icons-react';

interface QuickActionsPopupProps {
  onAttachFile: () => void;
  onTakePhoto: () => void;
  onStartVoice: () => void;
  onToggleDeepThought: () => void;
  isDeepThoughtEnabled: boolean;
  className?: string;
}

export const QuickActionsPopup: React.FC<QuickActionsPopupProps> = ({
  onAttachFile,
  onTakePhoto,
  onStartVoice,
  onToggleDeepThought,
  isDeepThoughtEnabled,
  className = '',
}) => {
  const [isOpen, setIsOpen] = useState(false);

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
      id: 'voice',
      icon: <IconMicrophone size={24} />,
      onClick: () => {
        onStartVoice();
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

  return (
    <>
      {/* Main + Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`
          relative flex h-10 w-10 items-center justify-center rounded-full
          border border-white/20 bg-white/20 backdrop-blur-xl
          text-neutral-700 transition-all duration-200
          hover:border-nvidia-green/50 hover:bg-white/30 hover:text-nvidia-green
          active:scale-95 dark:border-white/10 dark:bg-white/10 dark:text-white/80
          dark:hover:border-nvidia-green/60 dark:hover:text-nvidia-green
          ${isOpen ? 'rotate-45' : ''}
          ${className}
        `}
        aria-label="Quick actions"
        aria-expanded={isOpen}
      >
        <IconPlus size={24} className="transition-transform duration-200" />
      </button>

      {/* Overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm animate-fade-in"
          onClick={() => setIsOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Popup Menu */}
      {isOpen && (
        <div
          className={`
            absolute bottom-full left-0 z-50 mb-3
            rounded-2xl apple-glass backdrop-blur-xl
            border border-white/20 dark:border-white/10
            shadow-[0_14px_32px_rgba(6,15,11,0.35)] dark:shadow-[0_14px_38px_rgba(3,8,6,0.45)]
            animate-slide-up origin-bottom-left
            min-w-[240px]
          `}
          role="menu"
          aria-orientation="horizontal"
        >
          <div className="grid grid-cols-4 gap-2 p-3">
            {actions.map((action, index) => (
              <button
                key={action.id}
                onClick={action.onClick}
                className={`
                  relative flex items-center justify-center rounded-xl p-2
                  transition-all duration-150
                  hover:bg-white/20 dark:hover:bg-white/10
                  active:scale-[0.98]
                  ${action.isActive ? 'bg-nvidia-green/20 dark:bg-nvidia-green/15' : ''}
                `}
                role="menuitem"
              >
                <div
                  className={`
                    flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full
                    transition-all duration-150
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
      )}
    </>
  );
};
