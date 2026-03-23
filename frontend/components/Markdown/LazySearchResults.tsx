import dynamic from 'next/dynamic';
import { FC } from 'react';
import Loading from './Loading';

interface Props {
  payload?: any;
  children?: any;
}

const SearchResults = dynamic(
  () => import('./SearchResults'),
  {
    loading: () => <Loading message="Loading search results..." type="chart" />,
    ssr: false,
  }
);

export const LazySearchResults: FC<Props> = ({ payload }) => {
  return <SearchResults payload={payload} />;
};

LazySearchResults.displayName = 'LazySearchResults';
