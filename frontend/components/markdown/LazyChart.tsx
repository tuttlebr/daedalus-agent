import dynamic from 'next/dynamic';
import { FC } from 'react';
import Loading from './Loading';

interface Props {
  payload?: any;
  children?: any;
  inline?: boolean;
}

// Lazy load the Chart component
const Chart = dynamic(
  () => import('./Chart'),
  {
    loading: () => <Loading message="Loading chart..." type="chart" />,
    ssr: false, // Charts don't need SSR
  }
);

export const LazyChart: FC<Props> = (props) => {
  return <Chart {...props} />;
};

LazyChart.displayName = 'LazyChart';
