import { IconMenu2 } from '@tabler/icons-react';
interface Props {
  onClick: any;
  side: 'left' | 'right';
}

export const CloseSidebarButton = ({ onClick, side }: Props) => {
  return (
    <button
      className="flex items-center justify-center rounded-xl p-2 text-white/60 transition-all duration-200 hover:bg-white/10 hover:text-white hover:shadow-[0_0_15px_rgba(118,185,0,0.2)] flex-shrink-0"
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
      className={`absolute top-2.5 ${side === 'right' ? 'right-2' : 'left-2'}
      z-50 p-2 rounded-xl apple-glass text-white/80 hover:text-white hover:shadow-[0_0_20px_rgba(118,185,0,0.3)] transition-all duration-200`}
      onClick={onClick}
      aria-label="Open sidebar"
      style={safeAreaStyles}
    >
      <IconMenu2 size={20} />
    </button>
  );
};
