import { IconFolderPlus, IconMistOff, IconPlus } from '@tabler/icons-react';
import { ReactNode, RefObject, memo, useCallback } from 'react';
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
  loading?: boolean;
  loadingComponent?: ReactNode;
  searchInputRef?: RefObject<HTMLInputElement>;
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
  loading = false,
  loadingComponent,
  searchInputRef,
}: Props<T>) => {
  const { t } = useTranslation('promptbar');

  const allowDrop = useCallback((e: any) => {
    e.preventDefault();
  }, []);

  const highlightDrop = useCallback((e: any) => {
    e.target.style.background = 'rgba(118, 185, 0, 0.1)';
  }, []);

  const removeHighlight = useCallback((e: any) => {
    e.target.style.background = 'transparent';
  }, []);

  return (
    <>
      {isOpen ? (
        <nav
          className={`fixed md:relative top-0 ${side}-0 z-50 flex h-full w-full md:w-full flex-none flex-col space-y-2 liquid-glass-nav p-2 text-[14px] animate-slide-glass`}
          style={{
            paddingTop: 'max(1rem, calc(env(safe-area-inset-top) + 24px))',
          }}
          data-sidebar-desktop="open"
          role="navigation"
          aria-label={side === 'left' ? 'Conversation history' : 'Quick actions'}
        >
          {/* Header with actions */}
          <div className="relative">
            {/* Close button positioned absolutely to prevent overhang */}
            <div className="absolute -right-1 -top-1 z-10">
              <CloseSidebarButton onClick={toggleOpen} side={side} />
            </div>

            {/* Main action buttons with liquid glass */}
            <div className="flex items-center gap-2 pr-12">
              <button
                className="text-sidebar liquid-glass-control flex flex-1 cursor-pointer select-none items-center gap-3 rounded-2xl p-3 text-white transition-all duration-250 hover:border-nvidia-green/30 hover:shadow-[0_0_20px_rgba(118,185,0,0.25)] hover:scale-[1.02] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40"
                onClick={() => {
                  handleCreateItem();
                  handleSearchTerm('');
                }}
              >
                <IconPlus size={20} className="flex-shrink-0" />
                <span className="truncate font-medium">{addItemButtonTitle}</span>
              </button>

              <button
                className="liquid-glass-control flex items-center justify-center rounded-2xl p-3 text-sm text-white transition-all duration-250 hover:border-nvidia-green/30 hover:shadow-[0_0_20px_rgba(118,185,0,0.25)] hover:scale-[1.02] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40 flex-shrink-0"
                onClick={handleCreateFolder}
                aria-label="Create folder"
              >
                <IconFolderPlus size={20} />
              </button>
            </div>
          </div>
          <Search
            ref={searchInputRef}
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

            {loading && items?.length === 0 && loadingComponent ? (
              // Show loading skeleton when loading with no items
              <div className="pt-2">
                {loadingComponent}
              </div>
            ) : items?.length > 0 ? (
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
              <div className="mt-8 select-none text-center p-4 animate-morph-in">
                <div className="rounded-2xl p-6 mx-2 bg-white/5 border border-white/10 backdrop-blur-sm">
                  <IconMistOff className="mx-auto mb-3 text-white/40 animate-float" size={32} />
                  <span className="text-[14px] leading-normal text-white/60">
                    {t('No conversations yet. Click + to start chatting.')}
                  </span>
                </div>
              </div>
            )}
          </div>
          {footerComponent}
        </nav>
      ) : (
        <OpenSidebarButton onClick={toggleOpen} side={side} />
      )}
    </>
  );
};

// Create a type-safe memo wrapper for the generic component
const Sidebar = memo(SidebarComponent) as typeof SidebarComponent;

export default Sidebar;
