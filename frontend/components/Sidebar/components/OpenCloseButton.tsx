import { IconMenu2 } from '@tabler/icons-react';

interface ButtonBaseProps {
  onClick: () => void;
}

interface OpenButtonProps extends ButtonBaseProps {
  side: 'left' | 'right';
}

export const CloseSidebarButton = ({ onClick }: ButtonBaseProps) => {
  return (
    <button
      type="button"
      className="lg-floating-control !gap-0 !p-2 text-white/80"
      onClick={onClick}
      aria-label="Close sidebar"
    >
      <IconMenu2 size={20} />
    </button>
  );
};

export const OpenSidebarButton = ({ onClick, side }: OpenButtonProps) => {
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
      type="button"
      className={`hidden md:flex absolute ${
        side === 'right' ? 'right-2' : 'left-2'
      } z-50 rounded-2xl text-white/90 transition-all duration-200`}
      onClick={onClick}
      aria-label="Open sidebar"
      style={safeAreaStyles}
    >
      <span className="lg-floating-control !gap-2 text-white/90">
        <IconMenu2 size={20} />
        <span className="text-[0.65rem] uppercase tracking-[0.25em]">
          Panel
        </span>
      </span>
    </button>
  );
};
