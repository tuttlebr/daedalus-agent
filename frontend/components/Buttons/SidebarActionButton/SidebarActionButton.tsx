import { MouseEventHandler, ReactElement, memo } from 'react';

interface Props {
  handleClick: MouseEventHandler<HTMLButtonElement>;
  children: ReactElement;
}

const SidebarActionButton = memo<Props>(({ handleClick, children }) => (
  <button
    className="min-w-[20px] p-1.5 rounded-lg liquid-glass liquid-glass-subtle text-white/40 hover:text-white transition-all duration-300"
    onClick={handleClick}
  >
    {children}
  </button>
));

SidebarActionButton.displayName = 'SidebarActionButton';

export default SidebarActionButton;
