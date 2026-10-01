import { parentPort } from 'node:worker_threads';
import { createAnalysisEngine, type AnalysisRequest } from './analysis-engine';
const engine = createAnalysisEngine();
parentPort!.on('message', ({ id, request }: { id: number; request: AnalysisRequest }) => {
  try {
    parentPort!.postMessage({ id, result: engine.query(request) });
  } catch (error) {
    parentPort!.postMessage({ id, error: (error as Error).message });
  }
});
