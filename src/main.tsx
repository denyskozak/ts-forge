import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import { Theme } from '@radix-ui/themes';
import './styles.css';
import '@radix-ui/themes/styles.css';
import './radix-layout.css';
import App from './App';
import { Button } from './components/ui';
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="page-inner">
        <h1>The interface needs to reload.</h1>
        <p>Task state is stored locally. Reload to reconnect and review its status.</p>
        <Button primary onClick={() => location.reload()}>
          Reload Forge
        </Button>
      </main>
    ) : (
      this.props.children
    );
  }
}
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Theme appearance="dark" accentColor="amber" grayColor="sand" radius="large" scaling="95%">
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </Theme>
  </React.StrictMode>,
);
