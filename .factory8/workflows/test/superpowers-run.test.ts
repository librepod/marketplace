import { test } from 'node:test';
import assert from 'node:assert/strict';
import { superpowersRun, escalation, isStop, verdict, prUrl, prompts, type Band, type Io } from '../superpowers-run.ts';

const URL = 'https://github.com/o/r/pull/7';

// A fake Io: scripted review verdicts and human replies; records every step, prompt, question and pr() call.
function fake(verdicts: string[], replies: string[] = []) {
  const calls: string[] = [], prompts: Record<string, string> = {}, questions: string[] = [], prs: string[] = [];
  const io: Io = {
    async step(stage: string, prompt: string, band: Band) {
      calls.push(`${stage} ${band}`);
      prompts[stage] = prompt;
      if (stage === 'design') return `opened the PR\n${URL}`;
      if (stage === 'plan') assert.deepEqual(prs, [URL], 'pr() is called before plan runs');
      if (stage.startsWith('review-')) return `findings posted\nVerdict: ${verdicts.shift()}`;
      return 'ok';
    },
    async ask(q: string) { questions.push(q); return replies.shift()!; },
    pr(url: string) { prs.push(url); },
  };
  return { io, calls, prompts, questions, prs };
}

const start = ['design design', 'plan design', 'build implement'];

test('ready on first review', async () => {
  const f = fake(['ready']);
  assert.deepEqual(await superpowersRun(f.io, 'k3x9qa', 12), { outcome: 'ready', url: URL });
  assert.deepEqual(f.calls, [...start, 'review-1 review']);
  assert.deepEqual(f.questions, []);
  assert.deepEqual(f.prs, [URL]);
});

test('two fixes then ready', async () => {
  const f = fake(['changes', 'changes', 'ready']);
  assert.equal((await superpowersRun(f.io, 'k3x9qa', 12)).outcome, 'ready');
  assert.deepEqual(f.calls, [...start, 'review-1 review', 'fix-1 implement', 'review-2 review', 'fix-2 implement', 'review-3 review']);
  assert.deepEqual(f.questions, []);
});

test('escalates after 2 fix rounds, stop ends', async () => {
  const f = fake(['changes', 'changes', 'changes'], [' STOP ']);
  assert.deepEqual(await superpowersRun(f.io, 'k3x9qa', 12), { outcome: 'stopped', url: URL });
  assert.deepEqual(f.questions, [escalation(URL)]);
  assert.ok(!f.calls.includes('fix-3 implement'));
});

test('guidance gets a third fix carrying the reply, then asks again', async () => {
  const f = fake(['changes', 'changes', 'changes', 'changes'], ['use the existing helper', 'stop']);
  assert.equal((await superpowersRun(f.io, 'k3x9qa', 12)).outcome, 'stopped');
  assert.match(f.prompts['fix-3'], /use the existing helper/);
  assert.doesNotMatch(f.prompts['fix-1'], /use the existing helper/);
  assert.doesNotMatch(f.prompts['fix-2'], /use the existing helper/);
  assert.equal(f.questions.length, 2);
  assert.ok(f.calls.includes('review-4 review'));
});

test('escalation is the verbatim question', () => {
  assert.equal(escalation(URL), `Review still has Important findings after 2 fix rounds: ${URL}. Reply with guidance for another fix round, or "stop".`);
});

test('isStop', () => {
  assert.equal(isStop('stop'), true);
  assert.equal(isStop(' Stop\n'), true);
  assert.equal(isStop('stop doing X and do Y'), false);
  assert.equal(isStop(''), false);
});

test('verdict', () => {
  assert.equal(verdict('x\n**Verdict: ready** · https://github.com/o/r/pull/7\n\n'), 'ready');
  assert.equal(verdict('Verdict: changes'), 'changes');
  assert.throws(() => verdict('looks good'), /no Verdict line/);
});

test('verdict tolerates _emphasis_ and a trailing line after it', () => {
  assert.equal(verdict('x\n_Verdict: ready_'), 'ready');
  assert.equal(verdict('Verdict: changes\nComment: https://github.com/o/r/pull/7#issuecomment-1'), 'changes');
});

test('prompts fence off the interactive skills\' human gates', () => {
  assert.match(prompts.design('k3x9qa', 12), /builder check/i);
  assert.match(prompts.review('k3x9qa', 12), /no Critical or Important findings/);
  assert.match(prompts.build('k3x9qa', 12), /skip superpowers:finishing-a-development-branch/);
});

test('prUrl', () => {
  assert.equal(prUrl('https://github.com/o/r/pull/1 then https://github.com/o/r/pull/2.'), 'https://github.com/o/r/pull/2');
  assert.throws(() => prUrl('no link'), /no PR URL/);
});

test('prompts', () => {
  const d = prompts.design('k3x9qa', 12);
  for (const s of ['superpowers:brainstorming', 'docs/superpowers/specs/', 'gh pr create --draft', 'Run: k3x9qa', 'Fixes #12']) assert.ok(d.includes(s), s);
  const p = prompts.plan('k3x9qa', 12);
  assert.ok(p.includes('superpowers:writing-plans') && p.includes('docs/superpowers/plans/'));
  const r = prompts.review('k3x9qa', 12);
  assert.match(r, /spec and (the )?plan/i);
  assert.match(r, /issue/);
  assert.ok(r.includes('gh pr ready'));
  for (const s of [d, p, prompts.build('k3x9qa', 12), r, prompts.fix('k3x9qa', 12), prompts.fix('k3x9qa', 12, 'g')]) {
    assert.ok(s.includes('f8-ask'));
    assert.match(s, /never push to the default branch/i);
  }
});
