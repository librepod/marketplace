// The superpowers flow on this repo's project worker: binds superpowers-run.ts to factory8's run() and the
// FACTORY8_BANDS profiles. Runtime imports only @temporalio/workflow and @factory8/worker/flow: the image installs nothing else.
import { ApplicationFailure, TemporalFailure, proxyActivities } from '@temporalio/workflow';
import { run, type RunInput } from '@factory8/worker/flow';
import { superpowersRun, type Band, type Outcome } from './superpowers-run.ts';

// The package doesn't export the activities' types; this is the part of factory8's shipConfig the flow reads.
type Profile = { model: string; effort?: string };
const { shipConfig } = proxyActivities<{
  shipConfig(): Promise<{ bands: { design: Profile; implement: Profile[]; review: Profile } }>;
}>({ startToCloseTimeout: '5m', retry: { maximumAttempts: 1 } });

export async function superpowersWorkflow(input: RunInput): Promise<Outcome> {
  const { bands } = await shipConfig();
  const profiles: Record<Band, Profile> = { design: bands.design, implement: bands.implement[0], review: bands.review };
  const { state, step, ask } = run(input, { pr: undefined as string | undefined });
  try {
    return await superpowersRun({
      step: (stage, prompt, band) => step(stage, prompt, { profile: profiles[band] }),
      ask,
      pr: url => { state.pr = url; },
    }, input.runId, input.issue);
  } catch (e) {
    // A plain Error (a malformed summary) would fail the workflow task and retry it forever: fail the run instead.
    if (e instanceof TemporalFailure || !(e instanceof Error)) throw e;
    throw ApplicationFailure.nonRetryable(e.message, 'bad_summary');
  }
}
