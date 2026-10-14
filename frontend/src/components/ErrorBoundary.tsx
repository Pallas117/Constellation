import React, { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      // Visitors get a plain message; the stack (which names internals) only in development.
      return (
        <main role="alert" className="flex min-h-[100dvh] items-center justify-center bg-background px-4 text-foreground">
          <div className="hud-panel w-full max-w-lg p-8">
            <p className="brand-label">00_ERROR</p>
            <h1 className="mt-3 text-2xl font-semibold">Something went wrong on this page.</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Reloading usually fixes it. If it keeps happening, tell the Gauss team what you were doing.
            </p>
            {import.meta.env.DEV && this.state.error && (
              <pre className="mt-4 max-h-60 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-tight text-muted-foreground">
                {this.state.error.message}
                {"\n"}
                {this.state.error.stack}
              </pre>
            )}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 inline-flex min-h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Reload the page
            </button>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}
