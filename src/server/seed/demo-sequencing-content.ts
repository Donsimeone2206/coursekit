/**
 * "Inclusive design", a SCORM 2004 4th Edition package with real sequencing, written by hand so the
 * demo works offline:
 *  - a pre-test that records what the learner already knows in two global objectives;
 *  - two modules in a forced order: each is skipped when the pre-test (or the learner's earlier work)
 *    satisfied its objective, and module 2 stays disabled until module 1's objective is satisfied;
 *  - a final quiz (80% to pass, three attempts), disabled until both modules are satisfied;
 *  - rollup to the course: skipped modules don't count, and the course score is the quiz score.
 * Every part is the same SCO page (index.html?part=...), which talks to the SCORM 2004 API.
 */
import { strToU8, zipSync } from 'fflate';

const STYLE = `*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1e1b4b;background:#f8fafc}
main{max-width:760px;margin:0 auto;padding:28px 20px 44px}.badge{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#7c3aed}
h1{font-size:26px;line-height:1.25;margin:4px 0 14px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:26px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
nav{display:flex;justify-content:space-between;flex-wrap:wrap;margin-top:22px;gap:10px}button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:10px 18px;cursor:pointer;background:#7c3aed;color:#fff}
button.secondary{background:#ede9fe;color:#4c1d95}button:disabled{opacity:.5;cursor:default}button:focus-visible,label:focus-within{outline:3px solid #f59e0b;outline-offset:2px}
fieldset{border:0;margin:0 0 18px;padding:0}legend{font-weight:600;margin-bottom:8px}label{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:8px;cursor:pointer}
.tip{background:#f5f3ff;border-left:4px solid #7c3aed;padding:12px 16px;border-radius:8px}.result{font-size:44px;font-weight:700;margin:6px 0}.ok{color:#047857}.bad{color:#b91c1c}
.steps{display:flex;gap:6px;margin-bottom:18px}.steps span{flex:1;height:6px;border-radius:99px;background:#ede9fe}.steps span.on{background:#7c3aed}`;

const SCORM_JS = `// A small SCORM 2004 wrapper: finds API_1484_11 and keeps the calls in one place.
var Scorm = (function () {
  function find(win) {
    for (var i = 0; win && i < 10; i++) {
      try { if (win.API_1484_11) return win.API_1484_11; } catch (e) { return null; }
      if (!win.parent || win.parent === win) break;
      win = win.parent;
    }
    return null;
  }
  var api = find(window) || (window.opener ? find(window.opener) : null);
  var started = Date.now();
  var finished = false;
  return {
    available: function () { return !!api; },
    init: function () { return api ? api.Initialize('') === 'true' : false; },
    get: function (el) { return api ? api.GetValue(el) : ''; },
    set: function (el, v) { return api ? api.SetValue(el, String(v)) === 'true' : false; },
    commit: function () { return api ? api.Commit('') === 'true' : false; },
    /** Ends the session: exit is '' or 'suspend'; nav is an adl.nav.request ('' for none). */
    finish: function (exit, nav) {
      if (!api || finished) return;
      finished = true;
      api.SetValue('cmi.exit', exit);
      api.SetValue('cmi.session_time', 'PT' + Math.max(1, Math.round((Date.now() - started) / 1000)) + 'S');
      if (nav) api.SetValue('adl.nav.request', nav);
      api.Terminate('');
    },
    /** The index of a cmi.objectives entry by id (the LMS fills in the activity's objectives). */
    objective: function (id) {
      var n = Number(api ? api.GetValue('cmi.objectives._count') : 0) || 0;
      for (var i = 0; i < n; i++) if (api.GetValue('cmi.objectives.' + i + '.id') === id) return i;
      return -1;
    },
  };
})();
`;

const COURSE_JS = `var LESSONS = {
  'who-mismatch': { module: 'Module 1: Who we design for', title: 'Disability is a mismatch', pages: [
    '<p>The World Health Organization describes disability as a <strong>mismatch</strong> between a person and their environment, not a personal condition.</p><p>A door handle that needs a tight grip, a video without captions, a form that times out: each one excludes someone. Change the design and the mismatch goes away.</p>',
    '<p>Mismatches come in three kinds:</p><ul><li><strong>Permanent</strong>: someone who has one arm, or who is blind.</li><li><strong>Temporary</strong>: a broken wrist, an eye infection, recovering from surgery.</li><li><strong>Situational</strong>: a parent holding a baby, a bright screen in sunlight, a noisy train.</li></ul><p class="tip">Designing for the permanent case often helps everyone in the temporary and situational ones too.</p>'
  ] },
  'who-spectrum': { module: 'Module 1: Who we design for', title: 'The persona spectrum', pages: [
    '<p>A <strong>persona spectrum</strong> maps one need (touch, see, hear, speak) across the permanent, temporary and situational cases.</p><p>For "touch": one arm, an arm injury, a new parent. For "hear": deaf, an ear infection, a bartender in a loud bar.</p>',
    '<p>Use the spectrum early: pick a need, list the people across it, and test your idea with each of them in mind.</p><p class="tip">One good question for every design review: <em>who does this leave out?</em></p>'
  ] },
  'how-exclusion': { module: 'Module 2: Designing with inclusion', title: 'Learn from exclusion', pages: [
    '<p>Exclusion happens when we design for ourselves. Inclusive teams go looking for it: who struggles with this today, and why?</p><p>Watch real people use what you build, including people with disabilities, older people and people using assistive technology.</p>',
    '<p>Turn what you see into design principles. "Every action works with one hand" or "nothing depends on sound alone" are easy to test and hard to argue with.</p>'
  ] },
  'how-extend': { module: 'Module 2: Designing with inclusion', title: 'Solve for one, extend to many', pages: [
    '<p>Many everyday inventions began as solutions for one group: the typewriter, audiobooks, curb cuts, captions, voice control.</p><p>Solving for a specific person with a real constraint leads to ideas that work better for everyone.</p>',
    '<p>When you test, measure with the people at the edges first. If it works for them, it usually works for the middle too.</p><p class="tip">Next: the final quiz. You need 80% to pass.</p>'
  ] }
};
var PRETEST = [
  { id: 'p1', topic: 'who', text: 'In inclusive design, a disability is best described as...', options: ['A medical condition', 'A mismatch between a person and their environment', 'A rare edge case'], answer: 1 },
  { id: 'p2', topic: 'who', text: 'Holding a baby in one arm is an example of a...', options: ['Permanent disability', 'Temporary disability', 'Situational limitation'], answer: 2 },
  { id: 'p3', topic: 'how', text: 'Where do inclusive teams look for design ideas?', options: ['In the average user', 'In where people are excluded today', 'In competitors only'], answer: 1 },
  { id: 'p4', topic: 'how', text: '"Solve for one, extend to many" means...', options: ['Build only for one user', 'Solutions for a specific constraint often help everyone', 'Ship one feature at a time'], answer: 1 }
];
var QUIZ = [
  { id: 'q1', text: 'Which is a temporary disability?', options: ['Being deaf', 'A broken wrist', 'Using a phone in bright sunlight'], answer: 1 },
  { id: 'q2', text: 'What does a persona spectrum map?', options: ['Ages of users', 'One need across permanent, temporary and situational cases', 'Market segments'], answer: 1 },
  { id: 'q3', text: 'Which question belongs in every design review?', options: ['Who does this leave out?', 'Can we ship it faster?', 'Is it on brand?'], answer: 0 },
  { id: 'q4', text: 'Captions on videos help...', options: ['Only deaf people', 'Deaf people, people in noisy places and people learning a language', 'Nobody, in practice'], answer: 1 },
  { id: 'q5', text: 'A good inclusive design principle is...', options: ['"Looks modern"', '"Every action works with one hand"', '"Uses our brand colours"'], answer: 1 }
];
var part = new URLSearchParams(location.search).get('part') || 'who-mismatch';
var root;
var state = { page: 0, answers: {}, done: false };

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
function save() { Scorm.set('cmi.location', String(state.page)); Scorm.set('cmi.suspend_data', JSON.stringify(state)); Scorm.commit(); }
function steps(n, at) { var h = '<div class="steps" aria-hidden="true">'; for (var i = 0; i < n; i++) h += '<span class="' + (i <= at ? 'on' : '') + '"></span>'; return h + '</div>'; }
function questions(list) {
  var html = '';
  list.forEach(function (q, i) {
    html += '<fieldset><legend>' + (i + 1) + '. ' + esc(q.text) + '</legend>';
    q.options.forEach(function (o, j) {
      html += '<label><input type="radio" name="' + q.id + '" value="' + j + '"' + (state.answers[q.id] === j ? ' checked' : '') + '> <span>' + esc(o) + '</span></label>';
    });
    html += '</fieldset>';
  });
  return html;
}
function bindAnswers() { document.getElementById('form').onchange = function (e) { state.answers[e.target.name] = Number(e.target.value); save(); }; }
function missing(list) { return list.filter(function (q) { return state.answers[q.id] === undefined; }).length; }

function lesson() {
  var l = LESSONS[part];
  var p = state.page;
  var last = p === l.pages.length - 1;
  root.innerHTML = steps(l.pages.length, p) + '<div class="card"><p class="badge">' + esc(l.module) + '</p><h1>' + esc(l.title) + '</h1>' + l.pages[p] +
    '<nav><button class="secondary" id="back"' + (p === 0 ? ' disabled' : '') + '>Back</button><button id="next">' + (last ? 'Finish the lesson' : 'Next') + '</button></nav></div>';
  document.getElementById('back').onclick = function () { state.page--; save(); lesson(); };
  document.getElementById('next').onclick = function () {
    if (!last) { state.page++; save(); lesson(); return; }
    state.done = true;
    Scorm.set('cmi.completion_status', 'completed');
    Scorm.set('cmi.success_status', 'passed');
    save();
    Scorm.finish('', 'continue');
    root.innerHTML = '<div class="card"><h1>Lesson finished</h1><p>Opening the next part...</p></div>';
  };
}

function pretest() {
  if (state.done) return pretestResult();
  root.innerHTML = '<div class="card"><p class="badge">Pre-test</p><h1>What do you already know?</h1><p>Four quick questions. Modules you already know are skipped, and you can still open them from the contents.</p><form id="form">' +
    questions(PRETEST) + '<nav><span></span><button type="submit">See what to skip</button></nav></form></div>';
  bindAnswers();
  document.getElementById('form').onsubmit = function (e) {
    e.preventDefault();
    if (missing(PRETEST)) { alert('Answer every question first.'); return; }
    var right = 0;
    var topics = { who: true, how: true };
    PRETEST.forEach(function (q) { if (state.answers[q.id] === q.answer) right++; else topics[q.topic] = false; });
    ['who', 'how'].forEach(function (t) {
      var n = Scorm.objective('knows-' + t);
      if (n >= 0) Scorm.set('cmi.objectives.' + n + '.success_status', topics[t] ? 'passed' : 'failed');
    });
    Scorm.set('cmi.score.scaled', (right / PRETEST.length).toFixed(2));
    Scorm.set('cmi.completion_status', 'completed');
    Scorm.set('cmi.success_status', 'passed');
    state.done = true;
    state.topics = topics;
    save();
    pretestResult();
  };
}
function pretestResult() {
  var t = state.topics || {};
  var line = function (ok, name) { return '<li>' + (ok ? 'You know ' + name + ': this module is skipped.' : name + ': this module is next.') + '</li>'; };
  root.innerHTML = '<div class="card"><p class="badge">Pre-test</p><h1>Thanks!</h1><ul>' + line(t.who, 'Who we design for') + line(t.how, 'Designing with inclusion') +
    '</ul><nav><span></span><button id="go">Continue</button></nav></div>';
  document.getElementById('go').onclick = function () { Scorm.finish('', 'continue'); };
}

function quiz() {
  if (state.done) return quizResult();
  root.innerHTML = '<div class="card"><p class="badge">Final quiz</p><h1>Check your understanding</h1><p>Five questions. You need 80% to pass.</p><form id="form">' +
    questions(QUIZ) + '<nav><span></span><button type="submit">Submit answers</button></nav></form></div>';
  bindAnswers();
  document.getElementById('form').onsubmit = function (e) {
    e.preventDefault();
    if (missing(QUIZ)) { alert('Answer every question first.'); return; }
    var right = 0;
    QUIZ.forEach(function (q, i) {
      var n = 'cmi.interactions.' + i + '.';
      var ok = state.answers[q.id] === q.answer;
      if (ok) right++;
      Scorm.set(n + 'id', q.id);
      Scorm.set(n + 'type', 'choice');
      Scorm.set(n + 'learner_response', String.fromCharCode(97 + state.answers[q.id]));
      Scorm.set(n + 'result', ok ? 'correct' : 'incorrect');
    });
    state.score = right / QUIZ.length;
    Scorm.set('cmi.score.min', '0');
    Scorm.set('cmi.score.max', String(QUIZ.length));
    Scorm.set('cmi.score.raw', String(right));
    Scorm.set('cmi.score.scaled', state.score.toFixed(2));
    Scorm.set('cmi.completion_status', 'completed');
    state.done = true;
    save();
    quizResult();
  };
}
function quizResult() {
  var passed = Scorm.get('cmi.success_status') === 'passed' || state.score >= 0.8;
  var again = Scorm.get('adl.nav.request_valid.choice.{target=final-quiz}') === 'true';
  root.innerHTML = '<div class="card"><p class="badge">Your result</p><h1>' + (passed ? 'Well done!' : 'Nearly there') + '</h1><p class="result ' + (passed ? 'ok' : 'bad') + '">' +
    Math.round(state.score * 100) + '%</p><p>' + (passed ? 'You passed the inclusive design course.' : 'You need 80% to pass. Look back at a lesson from the contents, or try again.') +
    '</p><nav>' + (!passed && again ? '<button class="secondary" id="again">Try again</button>' : '<span></span>') + '<button id="done">' + (passed ? 'Finish the course' : 'End this attempt') + '</button></nav></div>';
  if (document.getElementById('again')) document.getElementById('again').onclick = function () { Scorm.finish('', '{target=final-quiz}choice'); };
  document.getElementById('done').onclick = function () { Scorm.finish('', passed ? 'continue' : 'exitAll'); };
}

window.addEventListener('load', function () {
  root = document.getElementById('app');
  if (!Scorm.available() || !Scorm.init()) {
    root.innerHTML = '<div class="card"><h1>Inclusive design</h1><p>Open this course from your Coursekit activity to record your progress.</p></div>';
    return;
  }
  if (Scorm.get('cmi.entry') === 'resume') {
    try { state = JSON.parse(Scorm.get('cmi.suspend_data')) || state; } catch (e) {}
  }
  if (Scorm.get('cmi.completion_status') === 'unknown') Scorm.set('cmi.completion_status', 'incomplete');
  if (part === 'pretest') pretest();
  else if (part === 'final') quiz();
  else lesson();
});
// Leaving part-way keeps the place: the next visit resumes it.
window.addEventListener('pagehide', function () { Scorm.finish(state.done ? '' : 'suspend', ''); });
`;

const INDEX = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Inclusive design</title>
<link rel="stylesheet" href="style.css">
<script src="scorm.js"></script>
<script src="course.js"></script>
</head>
<body>
<main><div id="app" aria-live="polite"><p>Loading…</p></div></main>
</body>
</html>
`;

const lesson = (id: string, title: string) =>
  `<item identifier="${id}" identifierref="res-course" parameters="?part=${id}"><title>${title}</title><imsss:sequencing IDRef="lesson"/></item>`;
const unlessSatisfied = (...objectives: string[]) =>
  `<imsss:preConditionRule><imsss:ruleConditions conditionCombination="any">${objectives
    .map(
      (o) =>
        `<imsss:ruleCondition referencedObjective="${o}" operator="not" condition="satisfied"/><imsss:ruleCondition referencedObjective="${o}" operator="not" condition="objectiveStatusKnown"/>`,
    )
    .join('')}</imsss:ruleConditions><imsss:ruleAction action="disabled"/></imsss:preConditionRule>`;
const SKIP_WHEN_SATISFIED = `<imsss:preConditionRule><imsss:ruleConditions><imsss:ruleCondition condition="satisfied"/></imsss:ruleConditions><imsss:ruleAction action="skip"/></imsss:preConditionRule>`;
const reads = (id: string, target: string) =>
  `<imsss:objective objectiveID="${id}"><imsss:mapInfo targetObjectiveID="${target}"/></imsss:objective>`;

export const DEMO_SEQUENCING_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="coursekit-inclusive-design" version="1"
  xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3"
  xmlns:adlseq="http://www.adlnet.org/xsd/adlseq_v1p3"
  xmlns:adlnav="http://www.adlnet.org/xsd/adlnav_v1p3"
  xmlns:imsss="http://www.imsglobal.org/xsd/imsss"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsglobal.org/xsd/imscp_v1p1 imscp_v1p1.xsd http://www.adlnet.org/xsd/adlcp_v1p3 adlcp_v1p3.xsd http://www.adlnet.org/xsd/adlseq_v1p3 adlseq_v1p3.xsd http://www.adlnet.org/xsd/adlnav_v1p3 adlnav_v1p3.xsd http://www.imsglobal.org/xsd/imsss imsss_v1p0.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>2004 4th Edition</schemaversion>
  </metadata>
  <organizations default="org-inclusive">
    <organization identifier="org-inclusive" adlseq:objectivesGlobalToSystem="false">
      <title>Inclusive design</title>
      <item identifier="pretest" identifierref="res-course" parameters="?part=pretest">
        <title>What do you already know?</title>
        <imsss:sequencing>
          <imsss:limitConditions attemptLimit="1"/>
          <imsss:rollupRules rollupObjectiveSatisfied="false" rollupProgressCompletion="false" objectiveMeasureWeight="0"/>
          <imsss:objectives>
            <imsss:primaryObjective objectiveID="pretest"/>
            <imsss:objective objectiveID="knows-who"><imsss:mapInfo targetObjectiveID="inclusive.who" readSatisfiedStatus="false" writeSatisfiedStatus="true"/></imsss:objective>
            <imsss:objective objectiveID="knows-how"><imsss:mapInfo targetObjectiveID="inclusive.how" readSatisfiedStatus="false" writeSatisfiedStatus="true"/></imsss:objective>
          </imsss:objectives>
        </imsss:sequencing>
      </item>
      <item identifier="module-who">
        <title>Module 1: Who we design for</title>
        ${lesson('who-mismatch', 'Disability is a mismatch')}
        ${lesson('who-spectrum', 'The persona spectrum')}
        <imsss:sequencing IDRef="module">
          <imsss:objectives>
            <imsss:primaryObjective objectiveID="module-who"><imsss:mapInfo targetObjectiveID="inclusive.who" writeSatisfiedStatus="true"/></imsss:primaryObjective>
          </imsss:objectives>
        </imsss:sequencing>
      </item>
      <item identifier="module-how">
        <title>Module 2: Designing with inclusion</title>
        ${lesson('how-exclusion', 'Learn from exclusion')}
        ${lesson('how-extend', 'Solve for one, extend to many')}
        <imsss:sequencing IDRef="module">
          <imsss:sequencingRules>${SKIP_WHEN_SATISFIED}${unlessSatisfied('after-who')}</imsss:sequencingRules>
          <imsss:objectives>
            <imsss:primaryObjective objectiveID="module-how"><imsss:mapInfo targetObjectiveID="inclusive.how" writeSatisfiedStatus="true"/></imsss:primaryObjective>
            ${reads('after-who', 'inclusive.who')}
          </imsss:objectives>
        </imsss:sequencing>
      </item>
      <item identifier="final-quiz" identifierref="res-course" parameters="?part=final">
        <title>Final quiz</title>
        <imsss:sequencing>
          <imsss:sequencingRules>${unlessSatisfied('after-who', 'after-how')}</imsss:sequencingRules>
          <imsss:limitConditions attemptLimit="3"/>
          <imsss:objectives>
            <imsss:primaryObjective objectiveID="final" satisfiedByMeasure="true"><imsss:minNormalizedMeasure>0.8</imsss:minNormalizedMeasure></imsss:primaryObjective>
            ${reads('after-who', 'inclusive.who')}
            ${reads('after-how', 'inclusive.how')}
          </imsss:objectives>
          <imsss:deliveryControls completionSetByContent="true" objectiveSetByContent="true"/>
        </imsss:sequencing>
        <adlnav:presentation><adlnav:navigationInterface><adlnav:hideLMSUI>previous</adlnav:hideLMSUI></adlnav:navigationInterface></adlnav:presentation>
      </item>
      <imsss:sequencing>
        <imsss:controlMode choice="true" flow="true"/>
      </imsss:sequencing>
    </organization>
  </organizations>
  <resources>
    <resource identifier="res-course" type="webcontent" adlcp:scormType="sco" href="index.html">
      <file href="index.html"/>
      <file href="style.css"/>
      <file href="scorm.js"/>
      <file href="course.js"/>
    </resource>
  </resources>
  <imsss:sequencingCollection>
    <imsss:sequencing ID="module">
      <imsss:controlMode choice="true" flow="true"/>
      <imsss:sequencingRules>${SKIP_WHEN_SATISFIED}</imsss:sequencingRules>
      <imsss:rollupRules objectiveMeasureWeight="0"/>
      <adlseq:rollupConsiderations requiredForSatisfied="ifNotSkipped" requiredForNotSatisfied="ifNotSkipped" requiredForCompleted="ifNotSkipped" requiredForIncomplete="ifNotSkipped"/>
    </imsss:sequencing>
    <imsss:sequencing ID="lesson">
      <imsss:deliveryControls completionSetByContent="true" objectiveSetByContent="true"/>
    </imsss:sequencing>
  </imsss:sequencingCollection>
</manifest>
`;

export function inclusiveDesignFiles(): Record<string, string> {
  return {
    'imsmanifest.xml': DEMO_SEQUENCING_MANIFEST,
    'index.html': INDEX,
    'style.css': STYLE,
    'scorm.js': SCORM_JS,
    'course.js': COURSE_JS,
  };
}

export function inclusiveDesignZip(): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(inclusiveDesignFiles()).map(([name, text]) => [name, strToU8(text)])));
}
