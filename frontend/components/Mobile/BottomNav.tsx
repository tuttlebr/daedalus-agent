import React, { useContext } from 'react';
import {
  IconPlus,
  IconMenu2,
  IconPaperclip,
  IconCamera,
  IconBrain,
} from '@tabler/icons-react';
import HomeContext from '@/pages/api/home/home.context';

interface NavItem {
  id: string;
  icon: React.ReactNode;
  label: string;
  action?: () => void;
  badge?: number;
}

interface BottomNavProps {
  onAttachFile?: () => void;
  onTakePhoto?: () => void;
  onToggleDeepThought?: () => void;
  isDeepThoughtEnabled?: boolean;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  onAttachFile,
  onTakePhoto,
  onToggleDeepThought,
  isDeepThoughtEnabled = false,
}) => {
  const {
    state: { showChatbar },
    dispatch: homeDispatch,
    handleNewConversation,
  } = useContext(HomeContext);

  const toggleChatbar = () => {
    homeDispatch({ field: 'showChatbar', value: !showChatbar });
  };

  const navItems: NavItem[] = [
    {
      id: 'menu',
      icon: <IconMenu2 size={22} />,
      label: 'Menu',
      action: toggleChatbar,
    },
    // Only show quick actions if handlers are provided
    ...(onAttachFile ? [{
      id: 'attach',
      icon: <IconPaperclip size={22} />,
      label: 'Attach',
      action: onAttachFile,
    }] : []),
    ...(onTakePhoto ? [{
      id: 'camera',
      icon: <IconCamera size={22} />,
      label: 'Camera',
      action: onTakePhoto,
    }] : []),
    ...(onToggleDeepThought ? [{
      id: 'deep-thought',
      icon: <IconBrain size={22} />,
      label: 'Think',
      action: onToggleDeepThought,
    }] : []),
    {
      id: 'new',
      icon: <IconPlus size={24} />,
      label: 'New',
      action: handleNewConversation,
    },
  ].filter(Boolean) as NavItem[];

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 md:hidden"
      role="navigation"
      aria-label="Mobile navigation"
      style={{
        paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 6px)',
        paddingLeft: 'env(safe-area-inset-left, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
      }}
    >
      {/* Frosted glass backdrop */}
      <div className="absolute inset-0 bg-black/60 dark:bg-black/70 backdrop-blur-xl border-t border-white/[0.06]" />
      <div className="relative flex items-center justify-around px-2 pt-1.5 pb-0.5">
        {navItems.map((item) => {
          const isActive = item.id === 'menu' && showChatbar;
          const isDeepThoughtActive = item.id === 'deep-thought' && isDeepThoughtEnabled;
          const isNewChat = item.id === 'new';
          const isHighlighted = isActive || isDeepThoughtActive;

          return (
            <button
              key={item.id}
              onClick={item.action}
              className={`
                relative flex flex-col items-center justify-center
                min-w-[52px] min-h-[48px] px-2.5 py-1.5 rounded-xl
                transition-all duration-150 ease-out
                focus:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/50
                active:scale-90
                ${isHighlighted
                  ? 'text-nvidia-green'
                  : isNewChat
                    ? 'text-nvidia-green/80'
                    : 'text-white/50 active:text-white/80'
                }
              `}
              aria-label={item.label}
              aria-pressed={isHighlighted}
            >
              <div className="relative">
                {item.icon}
                {item.badge && item.badge > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 flex items-center justify-center min-w-[16px] h-[16px] px-0.5 text-[9px] font-bold text-white bg-nvidia-green rounded-full">
                    {item.badge > 9 ? '9+' : item.badge}
                  </span>
                )}
                {item.id === 'deep-thought' && isDeepThoughtEnabled && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-nvidia-green rounded-full shadow-[0_0_6px_rgba(118,185,0,0.6)]" />
                )}
              </div>
              <span className={`text-[9px] font-medium mt-0.5 transition-colors duration-150 ${isHighlighted || isNewChat ? 'text-nvidia-green' : 'text-white/40'}`}>
                {item.label}
              </span>

              {/* Active pill indicator */}
              {isHighlighted && (
                <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-4 h-0.5 bg-nvidia-green rounded-full" />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
};
