import dynamic from 'next/dynamic';
import { FC } from 'react';
import Loading from './Loading';

interface Props {
  value: string;
}

// Lazy load the MermaidChart component
const MermaidChart = dynamic(
  () => import('./MermaidChart').then(mod => ({ default: mod.MermaidChart })),
  {
    loading: () => <Loading message="Loading diagram..." type="chart" />,
    ssr: false, // Mermaid requires DOM access
  }
);

export const LazyMermaidChart: FC<Props> = (props) => {
  return <MermaidChart {...props} />;
};

LazyMermaidChart.displayName = 'LazyMermaidChart';
