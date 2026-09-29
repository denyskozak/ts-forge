import { useEffect, useEffectEvent } from 'react';
import type { AgentEvent } from '../../shared/types';
import { api } from '../api';

/** Batch high-frequency IPC text; no timers run while the agent is idle. */
export function useAgentEvents(onEvent: (event: AgentEvent) => void) {
  const deliver = useEffectEvent(onEvent);
  useEffect(() => {
    let tokens = '',
      trainingText = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (tokens) {
        deliver({ type: 'token', text: tokens });
        tokens = '';
      }
      if (trainingText) {
        deliver({ type: 'training', text: trainingText, running: true });
        trainingText = '';
      }
    };
    const schedule = () => {
      timer ??= setTimeout(flush, 50);
    };
    const unsubscribe = api.onEvent((event) => {
      if (event.type === 'token') {
        tokens += event.text;
        schedule();
        return;
      }
      if (event.type === 'training' && event.running) {
        trainingText = (trainingText + event.text).slice(-60000);
        schedule();
        return;
      }
      // A final message or stop must not be followed by an old buffered chunk.
      flush();
      deliver(event);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);
}
