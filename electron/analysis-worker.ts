import { parentPort } from 'node:worker_threads';
import { languageQuery, type AnalysisRequest } from './analysis-engine';
parentPort!.on('message', (request: AnalysisRequest) => {
  try {
    parentPort!.postMessage({ result: languageQuery(request) });
  } catch (error) {
    parentPort!.postMessage({ error: (error as Error).message });
  }
});
