import { DEFAULT_SETTINGS, type ForgeAPI } from '../shared/types';
declare global {
  interface Window {
    forge?: ForgeAPI;
  }
}
export const isDesktop = !!window.forge;
const native = async (): Promise<never> => {
  throw new Error('Open the Electron app with npm run dev to use local files and models.');
};
export const api: ForgeAPI = window.forge ?? {
  state: async () => ({
    settings: DEFAULT_SETTINGS,
    workspace: null,
    workspaces: [],
    sessions: [],
    examples: [],
    platform: 'Browser preview',
    dataPath: 'Available in the desktop app',
  }),
  settings: native,
  models: native,
  testConnection: native,
  testSshProfile: native,
  analyzeProject: native,
  undoChange: native,
  undoChangeSet: native,
  acceptCriterion: native,
  analyzeImpact: native,
  validateTask: native,
  captureExample: native,
  deleteSession: native,
  openWorkspace: native,
  selectWorkspace: native,
  removeWorkspace: native,
  readFile: native,
  run: native,
  stop: native,
  approve: native,
  answerClarification: native,
  saveExample: native,
  deleteExample: native,
  reviewExample: native,
  exportDataset: native,
  train: native,
  stopTraining: native,
  pickPath: native,
  onEvent: () => () => {},
};
