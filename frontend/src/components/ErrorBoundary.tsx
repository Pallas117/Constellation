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
      return (
        <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-8 font-mono">
          <h1 className="text-2xl text-red-500 mb-4 font-bold uppercase tracking-tighter">System Error Detected</h1>
          <div className="bg-black/50 p-6 border border-red-500/30 rounded max-w-2xl w-full">
            <p className="text-red-400 mb-4">{this.state.error?.message}</p>
            <pre className="text-[10px] opacity-50 overflow-auto max-h-60 mt-4 leading-tight">
              {this.state.error?.stack}
            </pre>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="mt-8 px-6 py-2 border border-blue-500/50 hover:bg-blue-500/20 text-blue-400 uppercase text-xs tracking-widest transition-colors"
          >
            Attempt System Reboot
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
