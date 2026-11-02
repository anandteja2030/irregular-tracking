import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { AlertIcon } from "./icons";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Keeps a render fault inside the workspace instead of blanking the shell. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) {
      console.error("Workspace render fault", error, info.componentStack);
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="state state--error">
        <div className="state__glyph">
          <AlertIcon width={17} height={17} />
        </div>
        <p className="state__title">This surface failed to render</p>
        <p className="state__body">{error.message}</p>
        <div className="state__actions">
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => this.setState({ error: null })}
          >
            Reset surface
          </button>
        </div>
      </div>
    );
  }
}
