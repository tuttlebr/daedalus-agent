import { MouseEventHandler, ReactElement, memo } from 'react';

interface Props {
  handleClick: MouseEventHandler<HTMLButtonElement>;
  children: ReactElement;
}

const SidebarActionButton = memo<Props>(({ handleClick, children }) => (
  <button
    className="min-w-[20px] p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-all duration-200"
    onClick={handleClick}
  >
    {children}
  </button>
));

SidebarActionButton.displayName = 'SidebarActionButton';

export default SidebarActionButton;
