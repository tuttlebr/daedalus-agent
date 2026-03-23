import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-full items-center justify-center bg-[#0a0a0a]">
          <div className="mx-4 max-w-md rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur-xl animate-morph-in text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10">
              <svg
                className="h-8 w-8 text-red-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
                />
              </svg>
            </div>
            <h2 className="mb-2 text-xl font-semibold text-white">
              Something went wrong
            </h2>
            <p className="mb-6 text-sm text-white/60">
              {process.env.NODE_ENV === 'development' && this.state.error
                ? this.state.error.message
                : 'An unexpected error occurred. Please reload the page to try again.'}
            </p>
            <button
              onClick={this.handleReload}
              className="rounded-xl bg-nvidia-green px-6 py-3 text-sm font-medium text-white shadow-[0_0_20px_rgba(118,185,0,0.3)] transition-all hover:bg-nvidia-green-dark hover:shadow-[0_0_30px_rgba(118,185,0,0.5)]"
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
