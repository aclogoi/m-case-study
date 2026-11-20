import { Component, type ReactNode } from "react";

/** A rendering fault in one view shows a message instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="banner banner-critical banner-large" role="alert">
        <div className="banner-title">
          <span className="banner-icon" aria-hidden="true">!</span>
          This view could not be shown
        </div>
        <p>{this.state.error.message}</p>
        <p>Your decisions are kept. Switch to another view, or try this one again.</p>
        <button type="button" className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
