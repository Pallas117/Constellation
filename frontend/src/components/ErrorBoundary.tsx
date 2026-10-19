import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  /** Rendered in place of the children; without it the whole page is replaced. */
  fallback?: ReactNode;
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
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;

    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
        <div role="alert" className="hud-panel w-full max-w-lg p-6">
          <p className="brand-label">00_ERROR</p>
          <h1 className="mt-2 text-2xl font-semibold leading-tight">Something went wrong on this page.</h1>
          <p className="mt-2 text-sm text-muted-foreground">{this.state.error?.message}</p>
          {/* Stack traces are for developers; production users only see the message. */}
          {import.meta.env.DEV && this.state.error?.stack && (
            <pre className="mt-4 max-h-60 overflow-auto rounded-md border border-charcoal p-3 font-mono text-[11px] leading-tight text-muted-foreground">
              {this.state.error.stack}
            </pre>
          )}
          <Button className="mt-6" variant="outline" onClick={() => window.location.reload()}>
            Reload the page
          </Button>
        </div>
      </main>
    );
  }
}

/**
 * Keeps a WebGL failure local to the 3D view: the panels around the scene
 * (telemetry, controls, assistant) stay usable.
 */
export function SceneBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      fallback={
        <div className="absolute inset-0 flex items-center justify-center bg-background p-4">
          <div role="status" className="hud-panel max-w-sm p-4 text-center">
            <p className="text-sm font-semibold">3D view unavailable</p>
            <p className="mt-1 text-sm text-muted-foreground">
              WebGL could not start on this device. Live readings are not affected.
            </p>
          </div>
        </div>
      }
    >
      {children}
    </ErrorBoundary>
  );
}
