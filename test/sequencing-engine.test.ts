import { describe, expect, it } from 'vitest';
import { DEMO_SEQUENCING_MANIFEST } from '../src/server/seed/demo-sequencing-content.js';
import { Learner, FLOW, asset, cluster, control, manifest, objectiveReport, sco, structureOf, treeOf } from './sequencing-helpers.js';

const pre = (conditions: string, action: string, combination = 'all') =>
  `<imsss:preConditionRule><imsss:ruleConditions conditionCombination="${combination}">${conditions}</imsss:ruleConditions><imsss:ruleAction action="${action}"/></imsss:preConditionRule>`;
const post = (conditions: string, action: string, combination = 'all') =>
  `<imsss:postConditionRule><imsss:ruleConditions conditionCombination="${combination}">${conditions}</imsss:ruleConditions><imsss:ruleAction action="${action}"/></imsss:postConditionRule>`;
const exitRule = (conditions: string) =>
  `<imsss:exitConditionRule><imsss:ruleConditions>${conditions}</imsss:ruleConditions><imsss:ruleAction action="exit"/></imsss:exitConditionRule>`;
const cond = (condition: string, extra = '') => `<imsss:ruleCondition condition="${condition}" ${extra}/>`;
const rules = (...r: string[]) => `<imsss:sequencingRules>${r.join('')}</imsss:sequencingRules>`;

describe('defaults without sequencing information', () => {
  it('allows choice but not flow', () => {
    const l = new Learner(treeOf(manifest(sco('a') + sco('b'))));
    expect(l.nav('start')).toMatchObject({ valid: false, exception: 'SB.2.2-1' });
    expect(l.choosable()).toEqual(['a', 'b']);
    expect(l.go('choice', 'b')).toBe('b');
    const v = l.validity();
    expect(v).toMatchObject({ continue: false, previous: false, exit: true, exitAll: true, suspendAll: true });
    expect(l.nav('continue')).toMatchObject({ valid: false, exception: 'NB.2.1-4' });
    expect(l.go('choice', 'a')).toBe('a');
    // The SCO that never reported anything is completed and satisfied when its attempt ends.
    expect(l.status('b')).toMatchObject({ completed: true, satisfied: true });
  });
});

describe('forced sequential order (flow on, choice off)', () => {
  const tree = treeOf(manifest(sco('one') + sco('two') + sco('three'), FLOW));

  it('walks forward and back, and ends after the last activity', () => {
    const l = new Learner(tree);
    expect(l.go('start')).toBe('one');
    expect(l.choosable()).toEqual([]);
    expect(l.validity()).toMatchObject({ continue: true, previous: false });
    expect(l.nav('choice', 'three')).toMatchObject({ valid: false, exception: 'NB.2.1-10' });
    expect(l.go('continue')).toBe('two');
    expect(l.go('previous')).toBe('one');
    expect(l.activity('one').count).toBe(2);
    expect(l.go('continue')).toBe('two');
    expect(l.go('continue')).toBe('three');
    expect(l.validity().continue).toBe(true);
    expect(l.nav('continue')).toEqual({ valid: true, ended: true });
    expect(l.state).toMatchObject({ current: null, ended: true });
    expect(l.status('org')).toMatchObject({ completed: true, satisfied: true });
  });

  it('jumps anywhere the delivery rules allow, ignoring control modes', () => {
    const l = new Learner(tree);
    l.go('start');
    expect(l.validity().jump.has(l.index('three'))).toBe(true);
    expect(l.go('jump', 'three')).toBe('three');
  });
});

describe('a pre-test that skips what the learner already knows', () => {
  const pretest = sco(
    'pretest',
    `<imsss:objectives>
       <imsss:primaryObjective objectiveID="pretest"/>
       <imsss:objective objectiveID="knows-module"><imsss:mapInfo targetObjectiveID="g-module" readSatisfiedStatus="false" writeSatisfiedStatus="true"/></imsss:objective>
     </imsss:objectives>
     <imsss:rollupRules rollupObjectiveSatisfied="false" rollupProgressCompletion="false" objectiveMeasureWeight="0"/>`,
  );
  const module = cluster(
    'module',
    sco('lesson1') + sco('lesson2'),
    `${FLOW}${rules(pre(cond('satisfied'), 'skip'))}
     <imsss:objectives><imsss:primaryObjective objectiveID="module"><imsss:mapInfo targetObjectiveID="g-module" writeSatisfiedStatus="true"/></imsss:primaryObjective></imsss:objectives>
     <imsss:rollupRules objectiveMeasureWeight="0"/>
     <adlseq:rollupConsiderations requiredForSatisfied="ifNotSkipped" requiredForNotSatisfied="ifNotSkipped" requiredForCompleted="ifNotSkipped" requiredForIncomplete="ifNotSkipped"/>`,
  );
  const tree = treeOf(manifest(pretest + module + sco('final'), FLOW));

  it('skips the module after a passed pre-test, and still completes the course', () => {
    const l = new Learner(tree);
    expect(l.go('start')).toBe('pretest');
    l.finish('passed', 0.9, [objectiveReport('knows-module', 'passed')]);
    expect(l.state.globals['g-module']).toMatchObject({ ps: true, ss: true });
    // The pre-test weighs nothing: its score doesn't make the course's measure known.
    expect(l.status('org').measure).toBeNull();
    expect(l.go('continue')).toBe('final');
    expect(l.activity('module').count ?? 0).toBe(0);
    l.finish('passed', 0.8);
    expect(l.nav('continue')).toEqual({ valid: true, ended: true });
    // The skipped module doesn't hold back completion, and the pre-test doesn't count.
    expect(l.status('org')).toMatchObject({ completed: true, satisfied: true, measure: 0.8 });
  });

  it('delivers the module after a failed pre-test, and the module writes the objective when done', () => {
    const l = new Learner(tree);
    l.go('start');
    l.finish('passed', 0.4, [objectiveReport('knows-module', 'failed')]);
    expect(l.go('continue')).toBe('lesson1');
    l.finish();
    expect(l.go('continue')).toBe('lesson2');
    l.finish();
    expect(l.go('continue')).toBe('final');
    expect(l.status('module')).toMatchObject({ completed: true, satisfied: true });
    expect(l.state.globals['g-module']).toMatchObject({ ps: true, ss: true });
    // Going back: the module (now satisfied) is skipped, and so is the pre-test? No: it isn't, it has no skip rule.
    expect(l.go('previous')).toBe('pretest');
  });
});

describe('remediation with retry', () => {
  const quiz = sco(
    'quiz',
    `${rules(post(cond('satisfied', 'operator="not"'), 'exitParent'))}
     <imsss:objectives><imsss:primaryObjective objectiveID="quiz" satisfiedByMeasure="true"><imsss:minNormalizedMeasure>0.8</imsss:minNormalizedMeasure></imsss:primaryObjective></imsss:objectives>`,
  );
  const module = cluster('module', sco('lesson') + quiz, `${FLOW}${rules(post(cond('satisfied', 'operator="not"'), 'retry'))}`);
  const tree = treeOf(manifest(module + sco('wrapup'), FLOW));

  it('sends the learner back to the lesson until the quiz is passed', () => {
    const l = new Learner(tree);
    expect(l.go('start')).toBe('lesson');
    l.finish();
    expect(l.go('continue')).toBe('quiz');
    l.report({ completion: 'completed', scaled: 0.5 });
    expect(l.status('quiz')).toMatchObject({ satisfied: false });
    // quiz not satisfied -> exit parent -> module not satisfied -> retry the module.
    expect(l.go('continue')).toBe('lesson');
    expect(l.activity('module').count).toBe(2);
    expect(l.activity('lesson').count).toBe(2);
    // The lesson's information from the first module attempt no longer counts.
    expect(l.status('module').satisfied).toBeNull();
    l.finish();
    expect(l.go('continue')).toBe('quiz');
    l.report({ completion: 'completed', scaled: 0.9 });
    expect(l.go('continue')).toBe('wrapup');
    expect(l.status('module')).toMatchObject({ satisfied: true, completed: true });
  });
});

describe('a randomized test that selects some of its children', () => {
  const test = cluster(
    'test',
    sco('q1') + sco('q2') + sco('q3') + sco('q4'),
    `${control('choice="true" flow="true"')}<imsss:randomizationControls selectCount="2" selectionTiming="onEachNewAttempt" reorderChildren="true" randomizationTiming="onEachNewAttempt"/>`,
  );
  const tree = treeOf(manifest(test, control('choice="true" flow="true"')));

  it('delivers only the selected questions, in a reproducible order', () => {
    const l = new Learner(tree, 11);
    const available = l.activity('test').available!.map((i) => l.id(i));
    expect(available).toHaveLength(2);
    expect(new Set(available).size).toBe(2);
    const again = new Learner(tree, 11);
    expect(again.activity('test').available).toEqual(l.activity('test').available);
    expect(l.go('start')).toBe(available[0]);
    const unselected = ['q1', 'q2', 'q3', 'q4'].find((q) => !available.includes(q))!;
    // A question that wasn't selected isn't in the activity tree: the Navigation Request Process
    // refuses it before any termination, so the open question stays open.
    expect(l.nav('choice', unselected)).toMatchObject({ valid: false, exception: 'NB.2.1-11' });
    expect(l.current).toBe(available[0]);
    expect(l.activity(available[0]!)).toMatchObject({ active: true, count: 1 });
    expect(l.status(available[0]!).completed).toBeNull();
    expect(l.choosable()).not.toContain(unselected);
    l.finish();
    expect(l.go('continue')).toBe(available[1]);
    l.finish();
    expect(l.nav('continue')).toEqual({ valid: true, ended: true });
  });

  it('selects again for a new attempt on the test', () => {
    const l = new Learner(tree, 3);
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 6; attempt++) {
      for (const i of l.activity('test').available!) seen.add(l.id(i)!);
      const first = l.go(attempt === 0 ? 'start' : 'choice', attempt === 0 ? undefined : 'test');
      expect(l.activity('test').available!.map((i) => l.id(i))).toContain(first);
      l.nav('exit');
      expect(l.nav('exit')).toMatchObject({ valid: false });
      // Leaving the test ends its attempt (choice of another activity would too).
      l.seq().endAttempt(l.index('test'));
    }
    expect(seen.size).toBeGreaterThan(2);
  });
});

describe('rollup rules', () => {
  const rollupRule = (set: string, condition: string, action: string, extra = '') =>
    `<imsss:rollupRule childActivitySet="${set}" ${extra}><imsss:rollupConditions><imsss:rollupCondition condition="${condition}"/></imsss:rollupConditions><imsss:rollupAction action="${action}"/></imsss:rollupRule>`;
  const course = (rollup: string, children = sco('a') + sco('b') + sco('c') + sco('d')) =>
    treeOf(manifest(cluster('m', children, `${control('choice="true" flow="true"')}<imsss:rollupRules>${rollup}</imsss:rollupRules>`)));
  const run = (rollup: string, results: Array<'passed' | 'failed'>, children?: string) => {
    const l = new Learner(course(rollup, children));
    results.forEach((r, i) => {
      l.go('choice', 'abcd'[i]!);
      l.finish(r);
    });
    l.nav('exit');
    return l;
  };

  it('all, any and the defaults', () => {
    expect(run(rollupRule('any', 'satisfied', 'satisfied'), ['failed', 'passed']).status('m').satisfied).toBe(true);
    expect(run(rollupRule('all', 'satisfied', 'satisfied'), ['passed', 'passed', 'passed']).status('m').satisfied).toBeNull();
    expect(run(rollupRule('all', 'satisfied', 'satisfied'), ['passed', 'passed', 'passed', 'passed']).status('m').satisfied).toBe(true);
    // Default rules: not satisfied once every child is known and one failed.
    expect(run('', ['passed', 'failed', 'passed']).status('m').satisfied).toBeNull();
    expect(run('', ['passed', 'failed', 'passed', 'passed']).status('m').satisfied).toBe(false);
    expect(run('', ['passed', 'passed', 'passed', 'passed']).status('m')).toMatchObject({ satisfied: true, completed: true });
    expect(run(rollupRule('none', 'satisfied', 'notSatisfied'), ['failed', 'failed', 'failed', 'failed']).status('m').satisfied).toBe(
      false,
    );
  });

  it('atLeastCount and atLeastPercent', () => {
    const count = rollupRule('atLeastCount', 'satisfied', 'satisfied', 'minimumCount="2"');
    expect(run(count, ['passed', 'failed']).status('m').satisfied).toBeNull();
    expect(run(count, ['passed', 'failed', 'passed']).status('m').satisfied).toBe(true);
    const percent = rollupRule('atLeastPercent', 'satisfied', 'satisfied', 'minimumPercent="0.75"');
    expect(run(percent, ['passed', 'passed', 'failed', 'failed']).status('m').satisfied).toBeNull();
    expect(run(percent, ['passed', 'passed', 'passed', 'failed']).status('m').satisfied).toBe(true);
  });

  it('rollup considerations and rollup controls decide which children count', () => {
    const optional = (id: string, considerations: string) => sco(id, `<adlseq:rollupConsiderations ${considerations}/>`);
    const children =
      sco('a') +
      sco('b') +
      optional('c', 'requiredForSatisfied="ifAttempted" requiredForNotSatisfied="ifAttempted"') +
      sco('d', '<imsss:rollupRules rollupObjectiveSatisfied="false"/>');
    // c wasn't attempted and d never counts: a and b decide.
    expect(run('', ['passed', 'passed'], children).status('m').satisfied).toBe(true);
    const suspended = sco('a') + optional('b', 'requiredForCompleted="ifNotSuspended" requiredForIncomplete="ifNotSuspended"');
    const l = new Learner(course('', suspended));
    l.go('choice', 'a');
    l.finish();
    l.go('choice', 'b');
    l.report({ completion: 'incomplete' });
    l.activity('b').suspended = true;
    l.nav('suspendAll');
    // b is suspended, so only a decides completion.
    expect(l.status('m').completed).toBe(true);
  });

  it('weights measures and progress', () => {
    const weighted = sco('a') + sco('b', '<imsss:rollupRules objectiveMeasureWeight="0"/>') + sco('c');
    const l = new Learner(course('', weighted));
    l.go('choice', 'a');
    l.finish('passed', 0.6);
    l.go('choice', 'b');
    l.finish('passed', 0.1);
    l.go('choice', 'c');
    l.finish('passed', 1);
    expect(l.status('m').measure).toBeCloseTo(0.8, 6);
    expect(l.status('org').measure).toBeCloseTo(0.8, 6);
  });
});

describe('objective maps between activities', () => {
  it('reads and writes satisfaction, measures and 4th edition scores through global objectives', () => {
    const writer = sco(
      'writer',
      `<imsss:objectives><imsss:primaryObjective objectiveID="w"><imsss:mapInfo targetObjectiveID="shared" readSatisfiedStatus="false" readNormalizedMeasure="false" writeSatisfiedStatus="true" writeNormalizedMeasure="true"/></imsss:primaryObjective></imsss:objectives>
       <adlseq:objectives><adlseq:objective objectiveID="w"><adlseq:mapInfo targetObjectiveID="shared" writeRawScore="true" writeCompletionStatus="true"/></adlseq:objective></adlseq:objectives>`,
    );
    const reader = sco(
      'reader',
      `<imsss:objectives><imsss:primaryObjective objectiveID="r"><imsss:mapInfo targetObjectiveID="shared"/></imsss:primaryObjective></imsss:objectives>
       <adlseq:objectives><adlseq:objective objectiveID="r"><adlseq:mapInfo targetObjectiveID="shared"/></adlseq:objective></adlseq:objectives>`,
    );
    const l = new Learner(treeOf(manifest(writer + reader)));
    l.go('choice', 'writer');
    l.report({ completion: 'completed', success: 'failed', scaled: 0.3, raw: 3 });
    expect(l.state.globals.shared).toMatchObject({ ps: true, ss: false, ms: true, nm: 0.3, raw: 3, cps: true, cs: true });
    // The reader has nothing of its own yet: it reads the global objective.
    expect(l.status('reader')).toMatchObject({ satisfied: false, measure: 0.3, completed: true });
    const view = l.seq().objectiveView(l.index('reader'), 0);
    expect(view).toMatchObject({ success: 'failed', scaled: 0.3, raw: 3, completion: 'completed' });
    // Its own values win once it has them; unknown values are never written over a known global.
    l.go('choice', 'reader');
    l.report({ completion: 'incomplete', success: 'passed' });
    expect(l.status('reader')).toMatchObject({ satisfied: true, completed: false });
    l.go('choice', 'writer');
    l.report({ completion: 'unknown', success: 'unknown' });
    expect(l.state.globals.shared).toMatchObject({ ps: true, ss: false });
  });
});

describe('limit conditions', () => {
  it('disables an activity once its attempts are used up, but lets a suspended attempt resume', () => {
    const tree = treeOf(manifest(sco('once', '<imsss:limitConditions attemptLimit="1"/>') + sco('other')));
    const l = new Learner(tree);
    l.go('choice', 'once');
    l.nav('suspendAll');
    expect(l.go('resumeAll')).toBe('once');
    expect(l.activity('once').count).toBe(1);
    l.finish();
    l.go('choice', 'other');
    expect(l.choosable()).not.toContain('once');
    expect(l.nav('choice', 'once')).toMatchObject({ valid: false, exception: 'DB.1.1-3' });
    expect(l.nav('jump', 'once')).toMatchObject({ valid: false, exception: 'DB.1.1-3' });
  });

  it('evaluates attemptLimitExceeded and timeLimitExceeded rules', () => {
    const tree = treeOf(
      manifest(
        sco('timed', `<imsss:limitConditions attemptAbsoluteDurationLimit="PT10M"/>${rules(post(cond('timeLimitExceeded'), 'exitAll'))}`) +
          sco('next'),
        control('choice="true" flow="true"'),
      ),
    );
    const l = new Learner(tree);
    l.go('start');
    l.now += 11 * 60_000;
    expect(l.nav('continue')).toEqual({ valid: true, ended: true });
  });
});

describe('choice rules', () => {
  it('hides activities from choice', () => {
    const tree = treeOf(
      manifest(
        sco('intro') + sco('secret', rules(pre(cond('attempted', 'operator="not"'), 'hiddenFromChoice'))),
        control('choice="true" flow="true"'),
      ),
    );
    const l = new Learner(tree);
    expect(l.choosable()).toEqual(['intro']);
    l.go('start');
    expect(l.nav('choice', 'secret')).toMatchObject({ valid: false, exception: 'SB.2.9-3' });
    expect(l.go('continue')).toBe('secret');
    expect(l.choosable()).toEqual(['intro', 'secret']);
  });

  it('stops forward traversal until an activity is completed', () => {
    const tree = treeOf(
      manifest(
        sco('first', rules(pre(cond('completed', 'operator="not"'), 'stopForwardTraversal'))) + sco('second') + sco('third'),
        control('choice="true" flow="true"'),
      ),
    );
    const l = new Learner(tree);
    l.go('start');
    l.report({ completion: 'incomplete' });
    expect(l.choosable()).toEqual(['first']);
    expect(l.nav('choice', 'third')).toMatchObject({ valid: false, exception: 'SB.2.4-1' });
    // The refused choice still ended the attempt on first; choosing it again starts a new one.
    expect(l.choosable()).toEqual(['first']);
    expect(l.go('choice', 'first')).toBe('first');
    expect(l.activity('first').count).toBe(2);
    l.finish();
    expect(l.choosable()).toEqual(['first', 'second', 'third']);
    expect(l.go('choice', 'third')).toBe('third');
  });

  it('constrains choice to the next activities and prevents activation by choice', () => {
    const m = (id: string, seq = '') => cluster(id, sco(`${id}-1`) + sco(`${id}-2`), `${control('choice="true" flow="true"')}${seq}`);
    const tree = treeOf(
      manifest(
        m('m1', '<adlseq:constrainedChoiceConsiderations constrainChoice="true"/>') +
          m('m2') +
          m('m3', '<adlseq:constrainedChoiceConsiderations preventActivation="true"/>'),
        control('choice="true" flow="true"'),
      ),
    );
    const l = new Learner(tree);
    expect(l.go('start')).toBe('m1-1');
    // Inside m1 only the next activity (m2) and m1's own parts may be chosen.
    expect(l.choosable()).toEqual(['m1', 'm1-1', 'm1-2', 'm2', 'm2-1', 'm2-2']);
    expect(l.nav('choice', 'm3-1')).toMatchObject({ valid: false, exception: 'SB.2.9-8' });
    expect(l.go('choice', 'm2-2')).toBe('m2-2');
    // m3 has to be entered by flow, or chosen as a whole.
    expect(l.nav('choice', 'm3-2')).toMatchObject({ valid: false, exception: 'SB.2.9-6' });
    expect(l.go('choice', 'm3')).toBe('m3-1');
    expect(l.go('choice', 'm3-2')).toBe('m3-2');
  });

  it('keeps the learner inside an activity whose choiceExit is off', () => {
    const tree = treeOf(
      manifest(
        cluster('locked', sco('l1') + sco('l2'), control('choice="true" flow="true" choiceExit="false"')) + sco('outside'),
        control('choice="true" flow="true"'),
      ),
    );
    const l = new Learner(tree);
    l.go('start');
    expect(l.nav('choice', 'outside')).toMatchObject({ valid: false, exception: 'NB.2.1-8' });
    expect(l.go('choice', 'l2')).toBe('l2');
    expect(l.go('continue')).toBe('outside');
  });

  it('only moves forward in a forwardOnly cluster', () => {
    const tree = treeOf(manifest(cluster('m', sco('a') + sco('b') + sco('c'), control('choice="true" flow="true" forwardOnly="true"'))));
    const l = new Learner(tree);
    l.go('choice', 'a');
    expect(l.validity().previous).toBe(false);
    expect(l.nav('previous')).toMatchObject({ valid: false, exception: 'NB.2.1-5' });
    expect(l.go('choice', 'c')).toBe('c');
    expect(l.nav('choice', 'a')).toMatchObject({ valid: false, exception: 'SB.2.4-2' });
  });

  it('leaves a forward-only cluster backwards when all its children are skipped', () => {
    const skipped = rules(pre(cond('always'), 'skip'));
    const tree = treeOf(
      manifest(
        sco('a3') +
          cluster('a4', sco('a5', skipped) + sco('a6', skipped) + sco('a7', skipped), control('flow="true" forwardOnly="true"')) +
          sco('a8'),
        FLOW,
      ),
    );
    const l = new Learner(tree);
    expect(l.go('start')).toBe('a3');
    expect(l.go('continue')).toBe('a8');
    expect(l.go('previous')).toBe('a3');
  });
});

describe('suspend, resume, exit and abandon', () => {
  const tree = treeOf(manifest(cluster('m', sco('a') + sco('b'), FLOW) + sco('c'), FLOW));

  it('suspends everything and resumes the same attempt', () => {
    const l = new Learner(tree);
    l.go('start');
    l.go('continue');
    l.report({ completion: 'incomplete' });
    expect(l.nav('suspendAll')).toEqual({ valid: true, ended: true });
    expect(l.state).toMatchObject({ current: null, suspended: l.index('b') });
    expect(l.state.ended).toBeUndefined();
    expect(l.activity('m').suspended).toBe(true);
    expect(l.nav('start')).toMatchObject({ valid: true });
    // Starting again would begin a new attempt on a; resuming continues b.
    const r = new Learner(tree);
    r.go('start');
    r.go('continue');
    r.nav('suspendAll');
    expect(r.nav('resumeAll')).toMatchObject({ valid: true, newAttempt: false });
    expect(r.current).toBe('b');
    expect(r.activity('b')).toMatchObject({ count: 1, resumed: true, active: true, suspended: false });
    expect(r.activity('m').suspended).toBe(false);
  });

  it('exits the current activity, then everything', () => {
    const l = new Learner(tree);
    l.go('start');
    expect(l.nav('exit')).toEqual({ valid: true });
    expect(l.current).toBe('a');
    expect(l.activity('a').active).toBe(false);
    expect(l.validity()).toMatchObject({ exit: false, continue: true, exitAll: true });
    expect(l.go('continue')).toBe('b');
    expect(l.nav('exitAll')).toEqual({ valid: true, ended: true });
    expect(l.state.ended).toBe(true);
    expect(l.activity('org').active).toBe(false);
  });

  it('abandons without recording a result', () => {
    const l = new Learner(tree);
    l.go('start');
    expect(l.nav('abandon')).toEqual({ valid: true });
    expect(l.activity('a')).toMatchObject({ active: false });
    expect(l.status('a').completed).toBeNull();
    expect(l.go('continue')).toBe('b');
    expect(l.nav('abandonAll')).toEqual({ valid: true, ended: true });
    expect(l.status('b').completed).toBeNull();
  });

  it('applies exit action rules and post-condition rules', () => {
    const anySatisfied = `<imsss:rollupRules><imsss:rollupRule childActivitySet="any"><imsss:rollupConditions><imsss:rollupCondition condition="satisfied"/></imsss:rollupConditions><imsss:rollupAction action="satisfied"/></imsss:rollupRule></imsss:rollupRules>`;
    const t = treeOf(
      manifest(
        cluster('m', sco('a') + sco('b') + sco('extra'), `${FLOW}${rules(exitRule(cond('satisfied')))}${anySatisfied}`) +
          sco('c', rules(post(cond('always'), 'exitAll'))),
        FLOW,
      ),
    );
    const l = new Learner(t);
    l.go('start');
    l.report({ completion: 'completed', success: 'failed' });
    // m isn't satisfied: its exit rule doesn't fire and the flow goes on inside it.
    expect(l.go('continue')).toBe('b');
    l.finish();
    // b satisfies m (any child): its exit rule ends m, and the flow carries on after it.
    expect(l.go('continue')).toBe('c');
    expect(l.activity('m')).toMatchObject({ active: false });
    expect(l.activity('extra').count ?? 0).toBe(0);
    // c's post-condition rule ends everything, whatever the learner asked for.
    expect(l.nav('previous')).toEqual({ valid: true, ended: true });
    expect(l.state.ended).toBe(true);
  });

  it('retries the whole course with Retry All', () => {
    const t = treeOf(manifest(sco('lesson') + sco('test', rules(post(cond('satisfied', 'operator="not"'), 'retryAll'))), FLOW));
    const l = new Learner(t);
    l.go('start');
    l.finish();
    expect(l.go('continue')).toBe('test');
    l.report({ completion: 'completed', success: 'failed' });
    expect(l.go('continue')).toBe('lesson');
    expect(l.activity('org').count).toBe(2);
    expect(l.activity('lesson').count).toBe(2);
    // Nothing from the first try counts in the new attempt on the course.
    expect(l.status('org')).toMatchObject({ completed: null, satisfied: null });
    l.finish();
    l.go('continue');
    l.finish();
    expect(l.nav('continue')).toEqual({ valid: true, ended: true });
    expect(l.status('org')).toMatchObject({ completed: true, satisfied: true });
  });
});

describe('measures and progress', () => {
  it('measureSatisfactionIfActive', () => {
    const tree = treeOf(
      manifest(
        cluster(
          'm',
          sco('a') + sco('b', '<imsss:rollupRules objectiveMeasureWeight="0"/>'),
          `${control('choice="true" flow="true"')}
           <imsss:objectives><imsss:primaryObjective satisfiedByMeasure="true"><imsss:minNormalizedMeasure>0.5</imsss:minNormalizedMeasure></imsss:primaryObjective></imsss:objectives>
           <adlseq:rollupConsiderations measureSatisfactionIfActive="false"/>`,
        ) + sco('c'),
      ),
    );
    const l = new Learner(tree);
    l.go('choice', 'a');
    l.finish('unknown', 0.9);
    // m is active: its measure doesn't decide satisfaction yet.
    expect(l.status('m')).toMatchObject({ measure: 0.9, satisfied: null });
    l.go('choice', 'c');
    expect(l.status('m')).toMatchObject({ measure: 0.9, satisfied: true });
  });

  it('completedByMeasure on a SCO and on a cluster', () => {
    const threshold = (min: number, weight = 1) =>
      `<adlcp:completionThreshold completedByMeasure="true" minProgressMeasure="${min}" progressWeight="${weight}"/>`;
    const tree = treeOf(
      manifest(
        `<item identifier="m"><title>m</title>${sco('a', '', threshold(0.6))}${sco('b', '', threshold(0.6, 0.5))}${threshold(0.7)}</item>`,
      ),
    );
    const l = new Learner(tree);
    l.go('choice', 'a');
    l.report({ completion: 'completed', progress: 0.5 });
    expect(l.status('a').completed).toBe(false);
    l.report({ progress: 0.8 });
    expect(l.status('a').completed).toBe(true);
    l.go('choice', 'b');
    l.report({ progress: 0.2 });
    // m: (0.8 * 1 + 0.2 * 0.5) / 1.5 = 0.6 < 0.7
    expect(l.activity('m').ca).toBeCloseTo(0.6, 6);
    expect(l.status('m').completed).toBe(false);
    l.report({ progress: 0.5 });
    expect(l.status('m').completed).toBe(true);
  });
});

describe('assets', () => {
  it('count as completed once delivered', () => {
    const l = new Learner(treeOf(manifest(asset('reading') + sco('quiz'))));
    l.go('choice', 'reading');
    expect(l.status('reading')).toMatchObject({ completed: true, satisfied: true });
  });
});

describe('the Inclusive design demo package', () => {
  const tree = treeOf(DEMO_SEQUENCING_MANIFEST);
  const pretest = (who: 'passed' | 'failed', how: 'passed' | 'failed') => [
    objectiveReport('knows-who', who),
    objectiveReport('knows-how', how),
  ];

  it('reads without warnings', () => {
    expect(structureOf(DEMO_SEQUENCING_MANIFEST).warnings).toBeUndefined();
  });

  it('goes straight to the quiz when the pre-test shows both modules are known', () => {
    const l = new Learner(tree);
    expect(l.go('start')).toBe('pretest');
    l.finish('passed', 1, pretest('passed', 'passed'));
    expect(l.go('continue')).toBe('final-quiz');
    l.report({ completion: 'completed', scaled: 0.8 });
    expect(l.nav('continue')).toEqual({ valid: true, ended: true });
    expect(l.status('org-inclusive')).toMatchObject({ completed: true, satisfied: true, measure: 0.8 });
  });

  it('opens the modules in order and keeps the quiz locked until both are done', () => {
    const l = new Learner(tree);
    l.go('start');
    l.finish('passed', 0, pretest('failed', 'failed'));
    expect(l.go('continue')).toBe('who-mismatch');
    expect(l.choosable()).not.toContain('how-exclusion');
    expect(l.choosable()).not.toContain('final-quiz');
    expect(l.choosable()).not.toContain('pretest');
    // Leaving a lesson half-way doesn't satisfy it (its content sets completion and success).
    l.report({ completion: 'incomplete' });
    expect(l.validity().continue).toBe(true);
    expect(l.go('continue')).toBe('who-spectrum');
    l.finish();
    // Module 1 isn't satisfied yet (its first lesson was left unfinished): module 2 stays disabled.
    expect(l.validity().continue).toBe(false);
    expect(l.go('choice', 'who-mismatch')).toBe('who-mismatch');
    l.finish();
    expect(l.go('choice', 'how-exclusion')).toBe('how-exclusion');
    l.finish();
    expect(l.go('continue')).toBe('how-extend');
    l.finish();
    expect(l.go('continue')).toBe('final-quiz');
    l.report({ completion: 'completed', scaled: 0.6 });
    expect(l.status('final-quiz').satisfied).toBe(false);
    // A failed quiz can be taken again (three attempts in all).
    expect(l.go('choice', 'final-quiz')).toBe('final-quiz');
    expect(l.activity('final-quiz').count).toBe(2);
    l.report({ completion: 'completed', scaled: 1 });
    expect(l.nav('continue')).toEqual({ valid: true, ended: true });
    expect(l.status('org-inclusive')).toMatchObject({ completed: true, satisfied: true, measure: 1 });
  });
});

describe('identifiers that are also names on Object.prototype', () => {
  const FIELDS = ['ps', 'ss', 'ms', 'nm', 'raw', 'min', 'max', 'cps', 'cs', 'pms', 'pm'];

  it('keeps global objectives called "__proto__" or "constructor" in the attempt, never on shared objects', () => {
    const writer = sco(
      'writer',
      `<imsss:objectives><imsss:primaryObjective objectiveID="w">
         <imsss:mapInfo targetObjectiveID="__proto__" readSatisfiedStatus="false" writeSatisfiedStatus="true" writeNormalizedMeasure="true"/>
         <imsss:mapInfo targetObjectiveID="constructor" readSatisfiedStatus="false" writeSatisfiedStatus="true"/>
       </imsss:primaryObjective></imsss:objectives>
       <adlseq:objectives><adlseq:objective objectiveID="w"><adlseq:mapInfo targetObjectiveID="__proto__" writeCompletionStatus="true" writeRawScore="true"/></adlseq:objective></adlseq:objectives>`,
    );
    const reader = sco(
      'reader',
      `<imsss:objectives><imsss:primaryObjective objectiveID="r"><imsss:mapInfo targetObjectiveID="__proto__"/></imsss:primaryObjective>
         <imsss:objective objectiveID="r2"><imsss:mapInfo targetObjectiveID="toString"/></imsss:objective></imsss:objectives>`,
    );
    const l = new Learner(treeOf(manifest(writer + reader)));
    try {
      l.go('choice', 'writer');
      // Working out request validity ends the open attempt on a copy, and End Attempt writes the maps.
      l.validity();
      l.report({ completion: 'completed', success: 'failed', scaled: 0.4, raw: 4 });
      expect(l.go('choice', 'reader')).toBe('reader');
      for (const field of FIELDS) {
        expect(Object.hasOwn(Object.prototype, field), field).toBe(false);
        expect(Object.hasOwn(Object, field), field).toBe(false);
      }
      expect(({} as Record<string, unknown>).ps).toBeUndefined();
      const globals = l.state.globals;
      expect(Object.getPrototypeOf(globals)).toBe(Object.prototype);
      expect(Object.hasOwn(globals, '__proto__')).toBe(true);
      expect(globals['__proto__']).toEqual({ ps: true, ss: false, ms: true, nm: 0.4, raw: 4, cps: true, cs: true });
      expect(globals['constructor']).toEqual({ ps: true, ss: false });
      // They are read back like any other global objective; one nobody wrote is unknown.
      expect(l.status('reader')).toMatchObject({ satisfied: false, measure: 0.4 });
      expect(l.seq().satisfied(l.index('reader'), 1)).toBeNull();
      // And they survive the stored form of the state.
      const again = JSON.parse(JSON.stringify(l.state)) as typeof l.state;
      expect(Object.hasOwn(again.globals, '__proto__')).toBe(true);
      expect(Object.getPrototypeOf(again.globals)).toBe(Object.prototype);
    } finally {
      // Never leave a polluted prototype behind for the other tests of this worker.
      for (const field of FIELDS) {
        delete (Object.prototype as Record<string, unknown>)[field];
        delete (Object as unknown as Record<string, unknown>)[field];
      }
    }
  });
});

describe('referenced objectives in completed and activityProgressKnown rules (4th edition)', () => {
  // As in the well-known 4th edition golf example: each part is disabled (and hidden from choice)
  // until the part before it is completed, read through a global objective's completion status. The
  // content sets its own completion, so ending an attempt doesn't fill it in.
  const byContent = '<imsss:deliveryControls completionSetByContent="true" objectiveSetByContent="true"/>';
  const gated = (id: string, previous: string) =>
    sco(
      id,
      `${byContent}${rules(
        pre(
          cond('completed', 'referencedObjective="previous_sco_completed" operator="not"') +
            cond('activityProgressKnown', 'referencedObjective="previous_sco_completed" operator="not"'),
          'disabled',
          'any',
        ),
        pre(cond('completed', 'referencedObjective="previous_sco_completed" operator="not"'), 'hiddenFromChoice'),
      )}
       <imsss:objectives>
         <imsss:primaryObjective objectiveID="${id}"><imsss:mapInfo targetObjectiveID="g.${id}" readSatisfiedStatus="false"/></imsss:primaryObjective>
         <imsss:objective objectiveID="previous_sco_completed"><imsss:mapInfo targetObjectiveID="g.${previous}" readSatisfiedStatus="false"/></imsss:objective>
       </imsss:objectives>
       <adlseq:objectives>
         <adlseq:objective objectiveID="${id}"><adlseq:mapInfo targetObjectiveID="g.${id}" readCompletionStatus="false" writeCompletionStatus="true"/></adlseq:objective>
         <adlseq:objective objectiveID="previous_sco_completed"><adlseq:mapInfo targetObjectiveID="g.${previous}" readCompletionStatus="true"/></adlseq:objective>
       </adlseq:objectives>`,
    );
  const first = sco(
    'playing',
    `${byContent}<imsss:objectives><imsss:primaryObjective objectiveID="playing"><imsss:mapInfo targetObjectiveID="g.playing" readSatisfiedStatus="false"/></imsss:primaryObjective></imsss:objectives>
     <adlseq:objectives><adlseq:objective objectiveID="playing"><adlseq:mapInfo targetObjectiveID="g.playing" readCompletionStatus="false" writeCompletionStatus="true"/></adlseq:objective></adlseq:objectives>`,
  );
  const tree = treeOf(
    manifest(first + gated('etiquette', 'playing') + gated('handicapping', 'etiquette'), control('choice="true" flow="true"')),
  );

  it('reads the referenced objective, not the activity, so each part opens once the one before is completed', () => {
    expect(structureOf(manifest(first + gated('etiquette', 'playing'))).warnings).toBeUndefined();
    const l = new Learner(tree);
    expect(l.go('start')).toBe('playing');
    expect(l.choosable()).toEqual(['playing']);
    expect(l.validity().continue).toBe(false);
    l.report({ completion: 'completed' });
    expect(l.state.globals['g.playing']).toMatchObject({ cps: true, cs: true });
    expect(l.seq().objectiveCompleted(l.index('etiquette'), 1)).toBe(true);
    expect(l.choosable()).toEqual(['playing', 'etiquette']);
    expect(l.go('continue')).toBe('etiquette');
    // Not completed yet: the next part stays disabled and hidden.
    l.report({ completion: 'incomplete' });
    expect(l.choosable()).toEqual(['playing', 'etiquette']);
    expect(l.validity().continue).toBe(false);
    l.report({ completion: 'completed' });
    expect(l.go('continue')).toBe('handicapping');
  });

  it('leaves a condition about an objective the activity does not define unknown', () => {
    const odd = sco('odd', rules(pre(cond('completed', 'referencedObjective="nope"'), 'disabled')));
    const s = structureOf(manifest(sco('a') + odd));
    expect(s.warnings).toEqual(['"odd" has a rule about the objective "nope", which it doesn\'t define, so that condition is unknown.']);
    const l = new Learner(s.sequencing!);
    l.go('choice', 'odd');
    l.finish();
    // Its own completion would make the rule fire; the unknown objective doesn't.
    expect(l.choosable()).toContain('odd');
  });
});

describe('manifest limits', () => {
  const deep = (levels: number) => {
    let x = sco('leaf');
    for (let i = levels - 1; i > 0; i--) x = cluster(`c${i}`, x, control('choice="true" flow="true"'));
    return manifest(x, control('choice="true" flow="true"'));
  };

  it('refuses items nested more than 32 levels deep', () => {
    expect(structureOf(deep(32)).sequencing!.activities).toHaveLength(33);
    expect(() => structureOf(deep(33))).toThrow(/more than 32 levels deep/);
  });

  it('ignores rules, conditions and maps beyond what one activity may have, with a warning', () => {
    const wide = pre(Array.from({ length: 11 }, () => cond('always')).join(''), 'skip');
    const many = Array.from({ length: 25 }, () => pre(cond('always'), 'disabled'));
    const rollup = Array.from(
      { length: 21 },
      () =>
        '<imsss:rollupRule><imsss:rollupConditions><imsss:rollupCondition condition="satisfied"/></imsss:rollupConditions><imsss:rollupAction action="satisfied"/></imsss:rollupRule>',
    ).join('');
    const maps = Array.from({ length: 25 }, (_, i) => `<imsss:mapInfo targetObjectiveID="g${i}"/>`).join('');
    const adlMaps = Array.from({ length: 5 }, (_, i) => `<adlseq:mapInfo targetObjectiveID="extra${i}"/>`).join('');
    const data = Array.from({ length: 25 }, (_, i) => `<adlcp:map targetID="d${i}"/>`).join('');
    const s = structureOf(
      manifest(
        cluster(
          'm',
          sco(
            'a',
            `${rules(wide, ...many)}<imsss:objectives><imsss:primaryObjective objectiveID="p">${maps}</imsss:primaryObjective></imsss:objectives>
             <adlseq:objectives><adlseq:objective objectiveID="p">${adlMaps}</adlseq:objective></adlseq:objectives>`,
            `<adlcp:data>${data}</adlcp:data>`,
          ),
          `<imsss:rollupRules>${rollup}</imsss:rollupRules>`,
        ),
      ),
    );
    const [, m, a] = s.sequencing!.activities;
    expect(a!.preRules).toHaveLength(20);
    expect(a!.preRules.every((r) => r.action === 'disabled')).toBe(true);
    expect(a!.objectives[0]!.maps).toHaveLength(20);
    expect(a!.dataMaps).toHaveLength(20);
    expect(m!.rollupRules).toHaveLength(20);
    expect(s.warnings).toEqual([
      '"m": it has more than 20 rollup rules, so the rest are ignored.',
      '"a": a pre-condition rule has more than 10 conditions, so the rule is ignored.',
      '"a": it has more than 20 pre-condition rules, so the rest are ignored.',
      '"a": it has more than 20 shared data maps, so the rest are ignored.',
      '"a": the objective "p" has more than 20 objective maps, so the rest are ignored.',
      '"a": the objective "p" has more than 20 objective maps, so the rest are ignored.',
    ]);
  });

  it('refuses a package whose sequencing collection repeats more rules than a package may have', () => {
    const shared = rules(...Array.from({ length: 20 }, () => pre(cond('satisfied') + cond('completed'), 'disabled')));
    const items = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `<item identifier="i${i}" identifierref="sco"><title>i${i}</title><imsss:sequencing IDRef="big"/></item>`,
      ).join('');
    const xml = (n: number) =>
      manifest(
        items(n),
        '',
        `<imsss:sequencingCollection><imsss:sequencing ID="big">${shared}</imsss:sequencing></imsss:sequencingCollection>`,
      );
    expect(structureOf(xml(1000)).sequencing!.activities).toHaveLength(1001);
    expect(() => structureOf(xml(1001))).toThrow(/too many sequencing rules/);
  });

  it('works out request validity quickly for the largest trees it takes', () => {
    // 64 branches 30 levels deep, each ending in a part that is always skipped: flow has to go through
    // all of them, from every one of the ~2000 activities a choice can target.
    const flowing = control('choice="true" flow="true"');
    let items = '';
    for (let b = 0; b < 64; b++) {
      let x = sco(`l${b}`, rules(pre(cond('always'), 'skip')));
      for (let i = 30; i > 0; i--) x = cluster(`c${b}-${i}`, x, flowing);
      items += x;
    }
    const l = new Learner(treeOf(manifest(items + sco('end'), flowing)));
    const started = performance.now();
    expect(l.go('start')).toBe('end');
    const valid = l.validity();
    expect(valid.choice.size).toBeGreaterThan(1900);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('warns about an IDRef that matches nothing, and not about a collection entry with two parts of a kind', () => {
    const s = structureOf(
      manifest(
        `<item identifier="a" identifierref="sco"><title>a</title><imsss:sequencing IDRef="no-such-set"/></item>` +
          `<item identifier="b" identifierref="sco"><title>b</title><imsss:sequencing IDRef="shared"/></item>`,
        '',
        `<imsss:sequencingCollection><imsss:sequencing ID="shared"><imsss:limitConditions attemptLimit="2"/><imsss:limitConditions attemptLimit="5"/></imsss:sequencing></imsss:sequencingCollection>`,
      ),
    );
    expect(s.warnings).toEqual([
      '"a": its sequencing refers to "no-such-set", which isn\'t in the sequencing collection, so only its own rules are used.',
    ]);
    expect(s.sequencing!.activities[2]).toMatchObject({ id: 'b', attemptLimit: 2 });
  });
});
