import { IconFolderPlus, IconMistOff, IconPlus } from '@tabler/icons-react';
import { ReactNode, memo, useCallback } from 'react';
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

const SidebarComponent = <T,>({
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

  const allowDrop = useCallback((e: any) => {
    e.preventDefault();
  }, []);

  const highlightDrop = useCallback((e: any) => {
    e.target.style.background = 'rgba(78, 243, 255, 0.12)';
  }, []);

  const removeHighlight = useCallback((e: any) => {
    e.target.style.background = 'transparent';
  }, []);

  return (
    <>
      {isOpen ? (
        <div
          className={`fixed md:relative top-0 ${side}-0 z-50 flex h-full w-full md:w-[280px] flex-none flex-col gap-4 rounded-[28px] p-4 text-[0.85rem] text-white/90 transition-all duration-300 ease-out`}
          data-sidebar-desktop="open"
        >
          {/* Header with actions */}
          <div className="relative rounded-2xl border border-white/10 bg-gradient-to-br from-white/10 via-white/5 to-transparent p-4 backdrop-blur-md">
            <div className="absolute -right-2 -top-2 z-10">
              <CloseSidebarButton onClick={toggleOpen} side={side} />
            </div>

            <div className="flex items-center gap-3 pr-10">
              <button
                className="group flex flex-1 cursor-pointer select-none items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-[0.85rem] font-medium text-white transition-all duration-200 hover:border-white/30 hover:bg-white/15 hover:shadow-[0_18px_50px_-28px_rgba(4,9,27,0.95)]"
                onClick={() => {
                  handleCreateItem();
                  handleSearchTerm('');
                }}
              >
                <IconPlus size={20} className="flex-shrink-0" />
                <span className="truncate uppercase tracking-[0.15em]">
                  {addItemButtonTitle}
                </span>
              </button>

              <button
                className="flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 p-3 text-sm text-white transition-all duration-200 hover:border-white/25 hover:bg-white/15 hover:shadow-[0_18px_50px_-28px_rgba(4,9,27,0.95)]"
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

          <div className="lg-liquid-divider" />

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
              <div className="mt-8 select-none p-4 text-center">
                <div className="mx-2 rounded-3xl border border-dashed border-white/15 bg-white/5 p-6">
                  <IconMistOff className="mx-auto mb-3 text-white/50" size={32} />
                  <span className="text-[0.8rem] leading-normal text-white/70">
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
    </>
  );
};

// Create a type-safe memo wrapper for the generic component
const Sidebar = memo(SidebarComponent) as typeof SidebarComponent;

export default Sidebar;
