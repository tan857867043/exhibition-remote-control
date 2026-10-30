import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="app-shell bg-background text-foreground font-sans select-none flex items-center justify-center" style={{ height: '100vh' }}>
          <div className="max-w-md text-center space-y-4 p-8">
            <div className="w-16 h-16 mx-auto rounded-full bg-error/10 flex items-center justify-center">
              <span className="text-2xl">!</span>
            </div>
            <h2 className="text-lg font-semibold text-foreground">页面渲染异常</h2>
            <p className="text-sm text-muted-foreground">
              应用遇到了一个意外错误，可点击下方按钮重试。
            </p>
            <p className="text-xs font-mono text-muted-foreground/60 bg-muted rounded-md p-3 text-left break-all max-h-24 overflow-y-auto">
              {this.state.error?.message || '未知错误'}
            </p>
            <button
              onClick={this.handleRetry}
              className="px-4 py-2 rounded-md text-sm font-medium transition-colors"
              style={{ background: 'var(--ur-primary-600)', color: '#fff' }}
            >
              重试
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}