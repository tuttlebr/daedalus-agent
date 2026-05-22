import { FC } from 'react';

import dynamic from 'next/dynamic';

import Loading from './Loading';

interface Props {
  language: string;
  value: string;
  defaultPreview?: boolean;
}

// Lazy load the CodeBlock component
const CodeBlock = dynamic(
  () => import('./CodeBlock').then((mod) => ({ default: mod.CodeBlock })),
  {
    loading: () => <Loading message="Loading code viewer..." type="code" />,
    ssr: false, // Code highlighting isn't needed for SSR
  },
);

export const LazyCodeBlock: FC<Props> = (props) => {
  return <CodeBlock {...props} />;
};

LazyCodeBlock.displayName = 'LazyCodeBlock';
