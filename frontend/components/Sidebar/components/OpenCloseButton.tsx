import { IconMenu2 } from '@tabler/icons-react';

interface Props {
  onClick: any;
  side: 'left' | 'right';
}

export const CloseSidebarButton = ({ onClick, side }: Props) => {
  return (
    <button
      className="flex items-center justify-center rounded-md border border-white/20 p-3 text-white transition-colors duration-200 hover:bg-gray-500/10 flex-shrink-0"
      onClick={onClick}
      aria-label="Close sidebar"
    >
      <IconMenu2 size={20} />
    </button>
  );
};

export const OpenSidebarButton = ({ onClick, side }: Props) => {
  const safeAreaStyles =
    side === 'right'
      ? {
          top: 'calc(env(safe-area-inset-top) + 0.5rem)',
          right: 'calc(env(safe-area-inset-right) + 0.5rem)'
        }
      : {
          top: 'calc(env(safe-area-inset-top) + 0.5rem)',
          left: 'calc(env(safe-area-inset-left) + 0.5rem)'
        };

  return (
    <button
      className={`fixed top-2.5 ${
        side === 'right' ? 'right-2' : 'left-2'
      } z-50 p-1.5 rounded hover:bg-gray-500/10 text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-white transition-colors duration-200`}
      onClick={onClick}
      aria-label="Open sidebar"
      style={safeAreaStyles}
    >
      <IconMenu2 size={24} />
    </button>
  );
};
