import { sleep } from '@temporalio/workflow';
import { sdlcWorkflow } from '@factory8/worker/workflows';

export async function pilotWorkflow(): Promise<string> {
  await sleep('1s');
  return `pilot ok; sdlcWorkflow is a ${typeof sdlcWorkflow}`;
}
