import React, { useContext } from 'react';
import {
  IconPlus,
  IconMenu2,
  IconPaperclip,
  IconCamera,
  // IconMicrophone, // COMMENTED OUT - Voice recording disabled
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
  onStartVoice?: () => void;
  onToggleDeepThought?: () => void;
  isDeepThoughtEnabled?: boolean;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  onAttachFile,
  onTakePhoto,
  onStartVoice,
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
      icon: <IconMenu2 size={20} />,
      label: 'Menu',
      action: toggleChatbar,
    },
    // Only show quick actions if handlers are provided
    ...(onAttachFile ? [{
      id: 'attach',
      icon: <IconPaperclip size={20} />,
      label: 'Attach',
      action: onAttachFile,
    }] : []),
    ...(onTakePhoto ? [{
      id: 'camera',
      icon: <IconCamera size={20} />,
      label: 'Camera',
      action: onTakePhoto,
    }] : []),
    // COMMENTED OUT - Voice recording disabled
    // ...(onStartVoice ? [{
    //   id: 'voice',
    //   icon: <IconMicrophone size={20} />,
    //   label: 'Voice',
    //   action: onStartVoice,
    // }] : []),
    ...(onToggleDeepThought ? [{
      id: 'deep-thought',
      icon: <IconBrain size={20} />,
      label: 'Think',
      action: onToggleDeepThought,
    }] : []),
    {
      id: 'new',
      icon: <IconPlus size={22} />,
      label: 'New Chat',
      action: handleNewConversation,
    },
  ].filter(Boolean) as NavItem[];

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 glass safe-bottom md:hidden animate-slide-in"
      role="navigation"
      aria-label="Mobile navigation"
    >
      <div className="flex items-center justify-around h-16">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={item.action}
            className={`
              relative flex flex-col items-center justify-center
              w-full h-full px-1 py-1 rounded-lg
              text-gray-600 dark:text-gray-400
              hover:text-nvidia-green dark:hover:text-nvidia-green
              hover:bg-white/10 dark:hover:bg-white/5
              transition-all duration-200 transform active:scale-95
              focus:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green focus-visible:ring-inset
              ${item.id === 'new' ? 'text-nvidia-green dark:text-nvidia-green' : ''}
              ${item.id === 'deep-thought' ? (isDeepThoughtEnabled ? 'text-nvidia-green dark:text-nvidia-green bg-nvidia-green/10 dark:bg-nvidia-green/20' : '') : ''}
            `}
            aria-label={item.label}
          >
            <div className="relative">
              {item.icon}
              {item.badge && item.badge > 0 && (
                <span className="absolute -top-1 -right-1 flex items-center justify-center w-4 h-4 text-xs font-bold text-white bg-nvidia-green rounded-full">
                  {item.badge > 9 ? '9+' : item.badge}
                </span>
              )}
              {item.id === 'deep-thought' && isDeepThoughtEnabled && (
                <span className="absolute -top-1 -right-1 flex items-center justify-center w-2 h-2 bg-nvidia-green rounded-full animate-pulse" />
              )}
            </div>
            <span className="text-xs mt-1">{item.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
};
