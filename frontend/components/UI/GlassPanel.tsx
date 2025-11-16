import React, { HTMLAttributes } from 'react';
import classNames from 'classnames';

type SurfaceDepth = 'base' | 'raised' | 'floating';
type SurfaceGlow = 'none' | 'soft' | 'accent';
type IntrinsicElement = keyof JSX.IntrinsicElements;

export interface GlassPanelProps extends HTMLAttributes<HTMLElement> {
  as?: IntrinsicElement;
  depth?: SurfaceDepth;
  glow?: SurfaceGlow;
  interactive?: boolean;
}

export const GlassPanel: React.FC<GlassPanelProps> = ({
  as = 'div',
  depth = 'base',
  glow = 'none',
  interactive = false,
  className,
  children,
  ...rest
}) => {
  const Component = as;
  const dataAttributes = {
    'data-depth': depth !== 'base' ? depth : undefined,
    'data-glow': glow !== 'none' ? glow : undefined,
    'data-interactive': interactive ? 'true' : undefined,
  };

  return (
    <Component
      {...rest}
      {...dataAttributes}
      className={classNames('lg-glass', className)}
    >
      {children}
    </Component>
  );
};

