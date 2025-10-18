import { MouseEventHandler, ReactElement } from 'react';

interface Props {
  handleClick: MouseEventHandler<HTMLButtonElement>;
  children: ReactElement;
}

const SidebarActionButton = ({ handleClick, children }: Props) => (
  <button
    className="min-w-[20px] p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-all duration-200"
    onClick={handleClick}
  >
    {children}
  </button>
);

export default SidebarActionButton;
