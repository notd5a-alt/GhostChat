import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Synced crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            background: "#000",
            color: "#fff",
            fontFamily: "monospace",
            gap: "16px",
            padding: "24px",
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: "2rem", margin: 0 }}>SOMETHING WENT WRONG</h1>
          <p style={{ color: "rgba(255,255,255,0.5)", fontSize: "0.875rem" }}>
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 24px",
              border: "1px solid #fff",
              background: "transparent",
              color: "#fff",
              cursor: "pointer",
              fontFamily: "monospace",
              fontSize: "0.875rem",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            [ RELOAD ]
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
