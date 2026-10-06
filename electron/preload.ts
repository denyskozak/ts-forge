import { contextBridge, ipcRenderer } from 'electron';
import type { ForgeAPI, AgentEvent } from '../shared/types';
const api: ForgeAPI = {
  state: () => ipcRenderer.invoke('state'),
  settings: (value) => ipcRenderer.invoke('settings', value),
  models: () => ipcRenderer.invoke('models'),
  testConnection: (endpoint, model) => ipcRenderer.invoke('test-connection', endpoint, model),
  testSshProfile: (profile) => ipcRenderer.invoke('test-ssh-profile', profile),
  analyzeProject: () => ipcRenderer.invoke('analyze-project'),
  undoChange: (id) => ipcRenderer.invoke('undo-change', id),
  undoChangeSet: (id) => ipcRenderer.invoke('undo-changeset', id),
  acceptCriterion: (sessionId, criterionId) =>
    ipcRenderer.invoke('accept-criterion', sessionId, criterionId),
  analyzeImpact: (paths) => ipcRenderer.invoke('analyze-impact', paths),
  validateTask: (id, index) => ipcRenderer.invoke('validate-task', id, index),
  captureExample: (sessionId, messageId) =>
    ipcRenderer.invoke('capture-example', sessionId, messageId),
  deleteSession: (id) => ipcRenderer.invoke('delete-session', id),
  openWorkspace: () => ipcRenderer.invoke('workspace'),
  selectWorkspace: (path) => ipcRenderer.invoke('select-workspace', path),
  removeWorkspace: (path) => ipcRenderer.invoke('remove-workspace', path),
  readFile: (path) => ipcRenderer.invoke('read-file', path),
  run: (prompt, sessionId) => ipcRenderer.invoke('run', prompt, sessionId),
  resume: (sessionId) => ipcRenderer.invoke('resume', sessionId),
  previewImage: (path) => ipcRenderer.invoke('preview-image', path),
  showBrowser: () => ipcRenderer.invoke('show-browser'),
  openBrowser: (url) => ipcRenderer.invoke('open-browser', url),
  mcpConnections: () => ipcRenderer.invoke('mcp-connections'),
  connectMcp: (id) => ipcRenderer.invoke('connect-mcp', id),
  disconnectMcp: (id) => ipcRenderer.invoke('disconnect-mcp', id),
  stop: () => ipcRenderer.invoke('stop'),
  approve: (id, allow) => ipcRenderer.invoke('approve', id, allow),
  answerClarification: (id, optionId, text) =>
    ipcRenderer.invoke('answer-clarification', id, optionId, text),
  saveExample: (prompt, response) => ipcRenderer.invoke('save-example', prompt, response),
  reviewExample: (id, reviewed) => ipcRenderer.invoke('review-example', id, reviewed),
  deleteExample: (id) => ipcRenderer.invoke('delete-example', id),
  exportDataset: () => ipcRenderer.invoke('export-dataset'),
  train: (config) => ipcRenderer.invoke('train', config),
  stopTraining: () => ipcRenderer.invoke('stop-training'),
  pickPath: (kind) => ipcRenderer.invoke('pick-path', kind),
  packageScripts: () => ipcRenderer.invoke('package-scripts'),
  developmentProcesses: () => ipcRenderer.invoke('development-processes'),
  startDevelopmentProcess: (script) => ipcRenderer.invoke('start-development-process', script),
  stopDevelopmentProcess: (id) => ipcRenderer.invoke('stop-development-process', id),
  restartDevelopmentProcess: (id) => ipcRenderer.invoke('restart-development-process', id),
  productArchitecture: () => ipcRenderer.invoke('product-architecture'),
  createDisposableSqlite: () => ipcRenderer.invoke('create-disposable-sqlite'),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, data: AgentEvent) => callback(data);
    ipcRenderer.on('agent-event', listener);
    return () => ipcRenderer.removeListener('agent-event', listener);
  },
};
contextBridge.exposeInMainWorld('forge', api);
