import { FC } from 'react';

interface Props {
  text: string;
  icon: JSX.Element;
  onClick: () => void;
}

export const SidebarButton: FC<Props> = ({ text, icon, onClick }) => {
  return (
    <button
      className="flex w-full cursor-pointer select-none items-center gap-3 rounded-xl py-3 px-3 text-[14px] leading-3 text-white/90 transition-all duration-200 hover:bg-white/10 hover:text-white hover:shadow-[0_0_15px_rgba(118,185,0,0.1)]"
      onClick={onClick}
    >
      <div className="text-white/60">{icon}</div>
      <span>{text}</span>
    </button>
  );
};
