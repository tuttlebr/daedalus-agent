import { FC } from 'react';

interface Props {
  text: string;
  icon: JSX.Element;
  onClick: () => void;
}

export const SidebarButton: FC<Props> = ({ text, icon, onClick }) => {
  return (
    <button
      className="flex w-full cursor-pointer select-none items-center gap-3 rounded-2xl py-3 px-3 text-[14px] leading-3 text-white/90 transition-all duration-250 hover:bg-white/10 hover:text-white hover:shadow-[0_0_20px_rgba(118,185,0,0.2)] hover:border-nvidia-green/20 hover:scale-[1.01] active:scale-[0.99] border border-transparent"
      onClick={onClick}
    >
      <div className="text-white/60 transition-colors duration-250">{icon}</div>
      <span className="font-medium">{text}</span>
    </button>
  );
};
