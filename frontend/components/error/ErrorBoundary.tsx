'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';

import { reportError, userFacingMessage } from '@/utils/errorReporter';

import { Button } from '@/components/primitives';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  resetKey?: string | number;
}

interface State {
  hasError: boolean;
  error: Error | null;
  resetKey?: string | number;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  static getDerivedStateFromProps(
    props: Props,
    state: State,
  ): Partial<State> | null {
    if (state.hasError && props.resetKey !== state.resetKey) {
      return { hasError: false, error: null, resetKey: props.resetKey };
    }
    if (props.resetKey !== state.resetKey) {
      return { resetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error, {
      source: 'react-render',
      componentStack: info.componentStack ?? undefined,
    });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      const displayMessage = this.state.error
        ? userFacingMessage(this.state.error)
        : '';
      const showDetails =
        process.env.NODE_ENV !== 'production' && this.state.error;

      return (
        <div className="min-h-screen flex items-center justify-center bg-dark-bg-primary p-4">
          <div className="max-w-md w-full text-center space-y-6 animate-morph-in">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-nvidia-red/10 border border-nvidia-red/20 flex items-center justify-center">
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#e52020"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <div>
              <h2 className="text-xl font-semibold text-dark-text-primary">
                Something Went Wrong
              </h2>
              <p className="mt-2 text-sm text-dark-text-muted">
                {displayMessage ||
                  'An unexpected error occurred. Please try reloading the page.'}
              </p>
            </div>
            {showDetails && (
              <details className="text-left text-xs text-dark-text-muted bg-dark-bg-tertiary rounded-lg p-3 border border-white/5">
                <summary className="cursor-pointer font-medium">
                  Error Details (dev only)
                </summary>
                <pre className="mt-2 overflow-auto font-mono whitespace-pre-wrap">
                  {this.state.error?.message}
                  {this.state.error?.stack
                    ? `\n\n${this.state.error.stack}`
                    : ''}
                </pre>
              </details>
            )}
            <div className="flex gap-2 justify-center">
              <Button variant="secondary" onClick={this.handleReset}>
                Try Again
              </Button>
              <Button variant="accent" onClick={this.handleReload}>
                Reload Page
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
