import type {
  AgentEvent,
  AppState,
  Approval,
  Change,
  Clarification,
  Message,
  Session,
} from '../../shared/types';
export interface RunView {
  messages: Message[];
  changes: Change[];
  sessionId?: string;
  busy: boolean;
  status: string;
  stream: string;
  approval?: Approval;
  clarification?: Clarification;
}
export const initialRunView: RunView = {
  messages: [],
  changes: [],
  busy: false,
  status: 'Ready when you are',
  stream: '',
};
export type RunAction =
  | AgentEvent
  | { type: 'hydrate'; data: AppState }
  | { type: 'select'; session?: Session }
  | { type: 'start' }
  | { type: 'start-failed' }
  | { type: 'approved' }
  | { type: 'clarification-answered' };
/** Pure transitions: IPC, timers and persistence stay outside this module. */
export function runViewReducer(state: RunView, action: RunAction): RunView {
  switch (action.type) {
    case 'hydrate': {
      const run = action.data.activeRun;
      if (!run || !['running', 'waiting'].includes(run.status)) return state;
      const session = action.data.sessions.find((item) => item.id === run.sessionId);
      return {
        messages: session?.messages ?? [],
        changes: session?.changes ?? [],
        sessionId: run.sessionId,
        busy: true,
        status: run.label,
        stream: run.stream ?? '',
        approval: run.approval,
        clarification: run.clarification,
      };
    }
    case 'select':
      return state.busy
        ? state
        : {
            ...initialRunView,
            sessionId: action.session?.id,
            messages: action.session?.messages ?? [],
            changes: action.session?.changes ?? [],
          };
    case 'start':
      return {
        ...state,
        busy: true,
        stream: '',
        approval: undefined,
        clarification: undefined,
      };
    case 'start-failed':
      return { ...state, busy: false };
    case 'approved':
      return { ...state, approval: undefined };
    case 'clarification-answered':
      return { ...state, clarification: undefined };
    case 'token':
      return { ...state, stream: state.stream + action.text };
    case 'status':
      return state.status === action.status ? state : { ...state, status: action.status };
    case 'approval':
      return { ...state, approval: action.approval };
    case 'clarification':
      return { ...state, clarification: action.clarification };
    case 'message':
      return {
        ...state,
        messages: state.messages.some((m) => m.id === action.message.id)
          ? state.messages
          : [...state.messages, action.message],
        stream: action.message.role === 'assistant' ? '' : state.stream,
      };
    case 'change':
      return {
        ...state,
        changes: state.changes.some((c) => c.id === action.change.id)
          ? state.changes.map((c) => (c.id === action.change.id ? action.change : c))
          : [...state.changes, action.change],
      };
    case 'error':
      return { ...state, stream: '' };
    case 'done':
      return {
        ...initialRunView,
        sessionId: action.session.id,
        messages: action.session.messages,
        changes: action.session.changes ?? [],
      };
    default:
      return state;
  }
}
