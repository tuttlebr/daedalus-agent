import { IconFolderPlus, IconMistOff, IconPlus } from '@tabler/icons-react';
import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  CloseSidebarButton,
  OpenSidebarButton,
} from './components/OpenCloseButton';

import Search from '../Search';

interface Props<T> {
  isOpen: boolean;
  addItemButtonTitle: string;
  side: 'left' | 'right';
  items: T[];
  itemComponent: ReactNode;
  folderComponent: ReactNode;
  footerComponent?: ReactNode;
  searchTerm: string;
  handleSearchTerm: (searchTerm: string) => void;
  toggleOpen: () => void;
  handleCreateItem: () => void;
  handleCreateFolder: () => void;
  handleDrop: (e: any) => void;
}

const Sidebar = <T,>({
  isOpen,
  addItemButtonTitle,
  side,
  items,
  itemComponent,
  folderComponent,
  footerComponent,
  searchTerm,
  handleSearchTerm,
  toggleOpen,
  handleCreateItem,
  handleCreateFolder,
  handleDrop,
}: Props<T>) => {
  const { t } = useTranslation('promptbar');

  const allowDrop = (e: any) => {
    e.preventDefault();
  };

  const highlightDrop = (e: any) => {
    e.target.style.background = 'rgba(118, 185, 0, 0.1)';
  };

  const removeHighlight = (e: any) => {
    e.target.style.background = 'transparent';
  };

  return (
    <div className="relative h-full">
      {isOpen ? (
        <div
          className={`fixed md:relative top-0 ${side}-0 z-50 flex h-full w-[240px] lg:w-[260px] flex-none flex-col space-y-2 apple-glass-sidebar p-2 text-[14px] transition-all duration-300 ease-out animate-slide-in`}
          data-sidebar-desktop="open"
        >
          {/* Header with actions */}
          <div className="relative">
            {/* Close button positioned absolutely to prevent overhang */}
            <div className="absolute -right-1 -top-1 z-10">
              <CloseSidebarButton onClick={toggleOpen} side={side} />
            </div>

            {/* Main action buttons */}
            <div className="flex items-center gap-2 pr-12">
              <button
                className="text-sidebar flex flex-1 cursor-pointer select-none items-center gap-3 rounded-xl p-3 text-white transition-all duration-200 hover:bg-white/10 hover:shadow-[0_0_15px_rgba(118,185,0,0.2)] border border-white/5"
                onClick={() => {
                  handleCreateItem();
                  handleSearchTerm('');
                }}
              >
                <IconPlus size={20} className="flex-shrink-0" />
                <span className="truncate">{addItemButtonTitle}</span>
              </button>

              <button
                className="flex items-center justify-center rounded-xl p-3 text-sm text-white transition-all duration-200 hover:bg-white/10 hover:shadow-[0_0_15px_rgba(118,185,0,0.2)] flex-shrink-0 border border-white/5"
                onClick={handleCreateFolder}
                aria-label="Create folder"
              >
                <IconFolderPlus size={20} />
              </button>
            </div>
          </div>
          <Search
            placeholder={t('Search...') || ''}
            searchTerm={searchTerm}
            onSearch={handleSearchTerm}
          />

          <div className="flex-grow overflow-auto">
            {items?.length > 0 && (
              <div className="flex border-b border-white/10 pb-2">
                {folderComponent}
              </div>
            )}

            {items?.length > 0 ? (
              <div
                className="pt-2"
                onDrop={handleDrop}
                onDragOver={allowDrop}
                onDragEnter={highlightDrop}
                onDragLeave={removeHighlight}
              >
                {itemComponent}
              </div>
            ) : (
              <div className="mt-8 select-none text-center p-4">
                <div className="rounded-2xl p-6 mx-2 bg-white/5 border border-white/10">
                  <IconMistOff className="mx-auto mb-3 text-white/40" size={32} />
                  <span className="text-[14px] leading-normal text-white/60">
                    {t('No data.')}
                  </span>
                </div>
              </div>
            )}
          </div>
          {footerComponent}
        </div>
      ) : (
        <OpenSidebarButton onClick={toggleOpen} side={side} />
      )}
    </div>
  );
};

export default Sidebar;
