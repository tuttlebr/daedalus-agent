import { IconX, IconSearch } from '@tabler/icons-react';
import { FC, memo, useCallback } from 'react';

import { useTranslation } from 'next-i18next';

interface Props {
  placeholder: string;
  searchTerm: string;
  onSearch: (searchTerm: string) => void;
}
const Search: FC<Props> = memo(({ placeholder, searchTerm, onSearch }) => {
  const { t } = useTranslation('sidebar');

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onSearch(e.target.value);
  }, [onSearch]);

  const clearSearch = useCallback(() => {
    onSearch('');
  }, [onSearch]);

  return (
    <div className="relative flex items-center">
      <IconSearch className="absolute left-4 text-white/40 z-10" size={18} />
      <input
        className="w-full flex-1 rounded-xl apple-glass px-4 py-3 pl-10 pr-10 text-[14px] leading-3 text-white placeholder-white/40 focus:border-nvidia-green/40 focus:outline-none focus:ring-1 focus:ring-nvidia-green/40 transition-all duration-200"
        type="text"
        placeholder={t(placeholder) || ''}
        value={searchTerm}
        onChange={handleSearchChange}
      />

      {searchTerm && (
        <IconX
          className="absolute right-4 cursor-pointer text-white/40 hover:text-white transition-colors duration-200 active:scale-95 z-10"
          size={18}
          onClick={clearSearch}
        />
      )}
    </div>
  );
});

Search.displayName = 'Search';

export default Search;
