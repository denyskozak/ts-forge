import { contextBridge, ipcRenderer } from 'electron';
import type { ForgeAPI, AgentEvent } from '../shared/types';
const api: ForgeAPI = {
  state: () => ipcRenderer.invoke('state'),
  settings: (value) => ipcRenderer.invoke('settings', value),
  models: () => ipcRenderer.invoke('models'),
  testConnection: (endpoint, model) => ipcRenderer.invoke('test-connection', endpoint, model),
  analyzeProject: () => ipcRenderer.invoke('analyze-project'),
  undoChange: (id) => ipcRenderer.invoke('undo-change', id),
  captureExample: (sessionId, messageId) =>
    ipcRenderer.invoke('capture-example', sessionId, messageId),
  deleteSession: (id) => ipcRenderer.invoke('delete-session', id),
  openWorkspace: () => ipcRenderer.invoke('workspace'),
  selectWorkspace: (path) => ipcRenderer.invoke('select-workspace', path),
  removeWorkspace: (path) => ipcRenderer.invoke('remove-workspace', path),
  readFile: (path) => ipcRenderer.invoke('read-file', path),
  run: (prompt, sessionId) => ipcRenderer.invoke('run', prompt, sessionId),
  stop: () => ipcRenderer.invoke('stop'),
  approve: (id, allow) => ipcRenderer.invoke('approve', id, allow),
  answerClarification: (id, optionId) => ipcRenderer.invoke('answer-clarification', id, optionId),
  saveExample: (prompt, response) => ipcRenderer.invoke('save-example', prompt, response),
  reviewExample: (id, reviewed) => ipcRenderer.invoke('review-example', id, reviewed),
  deleteExample: (id) => ipcRenderer.invoke('delete-example', id),
  exportDataset: () => ipcRenderer.invoke('export-dataset'),
  train: (config) => ipcRenderer.invoke('train', config),
  stopTraining: () => ipcRenderer.invoke('stop-training'),
  pickPath: (kind) => ipcRenderer.invoke('pick-path', kind),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, data: AgentEvent) => callback(data);
    ipcRenderer.on('agent-event', listener);
    return () => ipcRenderer.removeListener('agent-event', listener);
  },
};
contextBridge.exposeInMainWorld('forge', api);
