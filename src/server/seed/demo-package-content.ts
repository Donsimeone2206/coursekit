/**
 * The demo content packages, written by hand so the demo works offline:
 *  - "Accessibility basics", a SCORM 1.2 module: four short pages and a five-question quiz that
 *    reports a score (mastery score 80), bookmarks the page and resumes where the learner left off.
 *  - "Colour contrast challenge", an xAPI (Tin Can) package that sends statements to the LRS it is
 *    launched with and keeps its place in the Activity State API.
 */
import { strToU8, zipSync } from 'fflate';

const STYLE = `*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1e1b4b;background:#f8fafc}
main{max-width:760px;margin:0 auto;padding:32px 24px 48px}header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:24px}
.badge{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#4f46e5}h1{font-size:28px;line-height:1.25;margin:4px 0 16px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.progress{height:6px;background:#e0e7ff;border-radius:99px;overflow:hidden;margin-bottom:24px}.progress span{display:block;height:100%;background:#4f46e5;transition:width .3s}
nav{display:flex;justify-content:space-between;margin-top:24px;gap:12px}button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:10px 18px;cursor:pointer;background:#4f46e5;color:#fff}
button.secondary{background:#e0e7ff;color:#312e81}button:disabled{opacity:.5;cursor:default}button:focus-visible,label:focus-within{outline:3px solid #f59e0b;outline-offset:2px}
fieldset{border:0;margin:0 0 20px;padding:0}legend{font-weight:600;margin-bottom:8px}label{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:8px;cursor:pointer}
.tip{background:#eef2ff;border-left:4px solid #4f46e5;padding:12px 16px;border-radius:8px}.result{font-size:48px;font-weight:700;margin:8px 0}.ok{color:#047857}.bad{color:#b91c1c}
.swatch{display:inline-block;padding:10px 14px;border-radius:8px;margin:4px 0;font-weight:600}`;

const SCORM_WRAPPER = `// A tiny SCORM 1.2 wrapper: finds the LMS API and keeps the calls in one place.
var Scorm = (function () {
  var api = null;
  function find(win) {
    for (var i = 0; win && i < 10; i++) {
      try { if (win.API) return win.API; } catch (e) { return null; }
      if (!win.parent || win.parent === win) break;
      win = win.parent;
    }
    return null;
  }
  api = find(window) || (window.opener ? find(window.opener) : null);
  var started = Date.now();
  var finished = false;
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function sessionTime() {
    var s = Math.round((Date.now() - started) / 1000);
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
  }
  return {
    available: function () { return !!api; },
    init: function () { return api ? api.LMSInitialize('') === 'true' : false; },
    get: function (el) { return api ? api.LMSGetValue(el) : ''; },
    set: function (el, v) { return api ? api.LMSSetValue(el, String(v)) === 'true' : false; },
    commit: function () { return api ? api.LMSCommit('') === 'true' : false; },
    finish: function (exit) {
      if (!api || finished) return;
      finished = true;
      api.LMSSetValue('cmi.core.exit', exit);
      api.LMSSetValue('cmi.core.session_time', sessionTime());
      api.LMSFinish('');
    },
  };
})();
`;

const MODULE_JS = `var PAGES = [
  { title: 'Why accessibility matters', html: '<p>More than a billion people live with some form of disability. Many more have a temporary or situational one: a broken arm, a noisy train, bright sunlight on a phone screen.</p><p>Accessible design means everyone can perceive, understand, navigate and interact with what you build. It is also good design: captions help people watching on mute, clear labels help everyone fill in a form faster.</p><p class="tip">This module follows the four principles of the Web Content Accessibility Guidelines (WCAG): <strong>perceivable, operable, understandable and robust</strong>.</p>' },
  { title: 'Perceivable', html: '<p>Information has to reach people through at least one of their senses.</p><ul><li><strong>Text alternatives:</strong> give every meaningful image an <code>alt</code> text that says what it shows or does. Decorative images get an empty <code>alt=""</code>.</li><li><strong>Captions and transcripts</strong> for audio and video.</li><li><strong>Contrast:</strong> body text needs a contrast ratio of at least <strong>4.5:1</strong> against its background (3:1 for large text).</li><li>Never use colour alone to carry meaning, like a red border for an error.</li></ul>' },
  { title: 'Operable', html: '<p>People need to be able to use every control, whatever they use to browse.</p><ul><li>Everything works with a <strong>keyboard</strong> alone: Tab to move, Enter or Space to activate.</li><li>The <strong>focus</strong> is always visible, so people know where they are.</li><li>Give people <strong>enough time</strong>, and let them pause anything that moves.</li><li>Avoid content that flashes more than three times a second.</li></ul><p class="tip">Try it: press Tab on this page. Can you see where the focus is?</p>' },
  { title: 'Understandable and robust', html: '<p>Interfaces should behave predictably and work with assistive technologies.</p><ul><li>Every form field has a visible <strong>label</strong>; errors say what went wrong and how to fix it.</li><li>Set the page <code>lang</code> so screen readers pronounce words correctly.</li><li>Use <strong>semantic HTML</strong> (<code>button</code>, <code>nav</code>, <code>h1</code>–<code>h6</code>) before reaching for ARIA. A <code>div</code> with a click handler is not a button.</li></ul><p>Ready? The quiz has five questions. You need 80% to pass.</p>' },
];
var QUESTIONS = [
  { id: 'q1-contrast', text: 'What is the minimum contrast ratio for normal body text (WCAG AA)?', options: ['2:1', '3:1', '4.5:1', '7:1'], answer: 2 },
  { id: 'q2-alt', text: 'What alt text should a purely decorative image have?', options: ['The file name', 'An empty alt attribute (alt="")', 'The word "image"', 'A long description'], answer: 1 },
  { id: 'q3-keyboard', text: 'Which keys should activate a button?', options: ['Only Enter', 'Enter or Space', 'Only the mouse', 'Escape'], answer: 1 },
  { id: 'q4-colour', text: 'A form shows errors only with a red border. What is the problem?', options: ['Red is too bright', 'Colour alone carries the meaning', 'Borders are not accessible', 'Nothing'], answer: 1 },
  { id: 'q5-semantic', text: 'What should you reach for first to make a control accessible?', options: ['ARIA roles', 'A div with a click handler', 'Semantic HTML elements', 'A tooltip'], answer: 2 },
];
var state = { page: 0, answers: {}, done: false };
var mastery = 80;
var root;

function save() {
  Scorm.set('cmi.core.lesson_location', String(state.page));
  Scorm.set('cmi.suspend_data', JSON.stringify(state));
  Scorm.commit();
}
function bar(step) {
  var total = PAGES.length + 2;
  return '<div class="progress" aria-hidden="true"><span style="width:' + Math.round((step / (total - 1)) * 100) + '%"></span></div>';
}
function render() {
  var p = state.page;
  if (p < PAGES.length) {
    root.innerHTML = bar(p) + '<div class="card"><p class="badge">Page ' + (p + 1) + ' of ' + PAGES.length + '</p><h1>' + PAGES[p].title + '</h1>' + PAGES[p].html +
      '<nav><button class="secondary" id="prev"' + (p === 0 ? ' disabled' : '') + '>Previous</button><button id="next">' + (p === PAGES.length - 1 ? 'Start the quiz' : 'Next') + '</button></nav></div>';
    document.getElementById('prev').onclick = function () { go(p - 1); };
    document.getElementById('next').onclick = function () { go(p + 1); };
  } else if (p === PAGES.length) {
    var html = bar(p) + '<div class="card"><p class="badge">Quiz</p><h1>Check your understanding</h1><form id="quiz">';
    QUESTIONS.forEach(function (q, i) {
      html += '<fieldset><legend>' + (i + 1) + '. ' + q.text + '</legend>';
      q.options.forEach(function (o, j) {
        var checked = state.answers[q.id] === j ? ' checked' : '';
        html += '<label><input type="radio" name="' + q.id + '" value="' + j + '"' + checked + '> <span>' + o.replace(/</g, '&lt;') + '</span></label>';
      });
      html += '</fieldset>';
    });
    html += '<nav><button type="button" class="secondary" id="back">Back to the lessons</button><button type="submit">Submit answers</button></nav></form></div>';
    root.innerHTML = html;
    document.getElementById('back').onclick = function () { go(PAGES.length - 1); };
    var form = document.getElementById('quiz');
    form.onchange = function (e) { state.answers[e.target.name] = Number(e.target.value); save(); };
    form.onsubmit = function (e) { e.preventDefault(); submit(); };
  } else {
    var score = scoreOf();
    var passed = score >= mastery;
    root.innerHTML = bar(p) + '<div class="card"><p class="badge">Your result</p><h1>' + (passed ? 'Well done!' : 'Nearly there') + '</h1><p class="result ' + (passed ? 'ok' : 'bad') + '">' + score + '%</p><p>' +
      (passed ? 'You passed the accessibility basics module.' : 'You need ' + mastery + '% to pass. Review the pages and try again in a new attempt.') +
      '</p><nav><button class="secondary" id="review">Review the pages</button><button id="finish">Finish</button></nav></div>';
    document.getElementById('review').onclick = function () { state.page = 0; render(); };
    document.getElementById('finish').onclick = function () {
      Scorm.finish('');
      root.innerHTML = '<div class="card"><h1>All done</h1><p>Your result has been saved. You can close this module.</p></div>';
    };
  }
}
function go(page) { state.page = Math.max(0, Math.min(page, PAGES.length)); save(); render(); window.scrollTo(0, 0); }
function scoreOf() {
  var right = 0;
  QUESTIONS.forEach(function (q) { if (state.answers[q.id] === q.answer) right++; });
  return Math.round((right / QUESTIONS.length) * 100);
}
function submit() {
  var missing = QUESTIONS.filter(function (q) { return state.answers[q.id] === undefined; });
  if (missing.length) { alert('Answer every question first (' + missing.length + ' left).'); return; }
  QUESTIONS.forEach(function (q, i) {
    var n = 'cmi.interactions.' + i + '.';
    Scorm.set(n + 'id', q.id);
    Scorm.set(n + 'type', 'choice');
    Scorm.set(n + 'student_response', String.fromCharCode(97 + state.answers[q.id]));
    Scorm.set(n + 'correct_responses.0.pattern', String.fromCharCode(97 + q.answer));
    Scorm.set(n + 'result', state.answers[q.id] === q.answer ? 'correct' : 'wrong');
  });
  var score = scoreOf();
  Scorm.set('cmi.core.score.min', '0');
  Scorm.set('cmi.core.score.max', '100');
  Scorm.set('cmi.core.score.raw', String(score));
  Scorm.set('cmi.core.lesson_status', score >= mastery ? 'passed' : 'failed');
  state.done = true;
  state.page = PAGES.length + 1;
  save();
  render();
}
window.addEventListener('load', function () {
  root = document.getElementById('app');
  if (!Scorm.available() || !Scorm.init()) {
    root.innerHTML = '<div class="card"><h1>Accessibility basics</h1><p>This module needs a SCORM 1.2 LMS to save your progress.</p></div>';
    return;
  }
  var m = Number(Scorm.get('cmi.student_data.mastery_score'));
  if (m > 0) mastery = m;
  if (Scorm.get('cmi.core.entry') === 'resume') {
    try { state = JSON.parse(Scorm.get('cmi.suspend_data')) || state; } catch (e) {}
  }
  if (Scorm.get('cmi.core.lesson_status') === 'not attempted') Scorm.set('cmi.core.lesson_status', 'incomplete');
  render();
});
window.addEventListener('pagehide', function () { Scorm.finish(state.done ? '' : 'suspend'); });
`;

const SCORM_INDEX = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Accessibility basics</title>
<link rel="stylesheet" href="style.css">
<script src="scorm.js"></script>
<script src="module.js"></script>
</head>
<body>
<main><header><span class="badge">Accessibility basics</span><span class="badge" style="color:#64748b">SCORM 1.2</span></header><div id="app" aria-live="polite"><p>Loading…</p></div></main>
</body>
</html>
`;

const SCORM_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="coursekit-accessibility-basics" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="org-accessibility">
    <organization identifier="org-accessibility">
      <title>Accessibility basics</title>
      <item identifier="item-accessibility" identifierref="res-accessibility" isvisible="true">
        <title>Accessibility basics</title>
        <adlcp:masteryscore>80</adlcp:masteryscore>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="res-accessibility" type="webcontent" adlcp:scormtype="sco" href="index.html">
      <file href="index.html"/>
      <file href="style.css"/>
      <file href="scorm.js"/>
      <file href="module.js"/>
    </resource>
  </resources>
</manifest>
`;

export const DEMO_XAPI_ACTIVITY = 'https://coursekit.test/xapi/colour-contrast-challenge';

const XAPI_JS = `// Colour contrast challenge: an xAPI package. Reads the launch parameters, talks to the LRS with fetch.
var params = new URLSearchParams(location.search);
var lrs = { endpoint: params.get('endpoint'), auth: params.get('auth') };
var actor = null;
try { actor = JSON.parse(params.get('actor')); } catch (e) {}
var registration = params.get('registration');
var activityId = params.get('activity_id') || '${DEMO_XAPI_ACTIVITY}';
var started = Date.now();
var ROUNDS = [
  { fg: '#767676', bg: '#ffffff', ratio: 4.54, text: 'Grey #767676 text on white' },
  { fg: '#ffffff', bg: '#ff8c00', ratio: 2.32, text: 'White text on orange #ff8c00' },
  { fg: '#1e3a8a', bg: '#dbeafe', ratio: 8.83, text: 'Navy #1e3a8a text on pale blue' },
  { fg: '#d1d5db', bg: '#f9fafb', ratio: 1.43, text: 'Light grey #d1d5db text on off-white' },
];
var state = { round: 0, answers: [] };
function verb(id, name) { return { id: 'http://adlnet.gov/expapi/verbs/' + id, display: { 'en-US': name } }; }
function duration() { return 'PT' + Math.round((Date.now() - started) / 1000) + 'S'; }
function api(path, options) {
  if (!lrs.endpoint) return Promise.resolve(null);
  options = options || {};
  options.headers = Object.assign({ Authorization: lrs.auth, 'X-Experience-API-Version': '1.0.3' }, options.headers || {});
  return fetch(lrs.endpoint.replace(/\\/?$/, '/') + path, options);
}
function send(v, extra) {
  var st = Object.assign({ actor: actor, verb: v, object: { objectType: 'Activity', id: activityId, definition: { name: { 'en-US': 'Colour contrast challenge' } } }, context: { registration: registration } }, extra || {});
  return api('statements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st) });
}
function stateUrl() {
  return 'activities/state?stateId=progress&activityId=' + encodeURIComponent(activityId) + '&agent=' + encodeURIComponent(JSON.stringify(actor)) + '&registration=' + registration;
}
function saveState() { return api(stateUrl(), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) }); }
function render() {
  var app = document.getElementById('app');
  if (state.round < ROUNDS.length) {
    var r = ROUNDS[state.round];
    app.innerHTML = '<div class="card"><p class="badge">Round ' + (state.round + 1) + ' of ' + ROUNDS.length + '</p><h1>Is this readable as body text?</h1>' +
      '<p class="swatch" style="color:' + r.fg + ';background:' + r.bg + '">The quick brown fox jumps over the lazy dog</p><p>' + r.text + '.</p>' +
      '<p>Body text needs a contrast ratio of at least 4.5:1.</p><nav><button id="no" class="secondary">Fails 4.5:1</button><button id="yes">Passes 4.5:1</button></nav></div>';
    document.getElementById('yes').onclick = function () { answer(true); };
    document.getElementById('no').onclick = function () { answer(false); };
  } else {
    var right = state.answers.filter(Boolean).length;
    var scaled = right / ROUNDS.length;
    var passed = scaled >= 0.75;
    app.innerHTML = '<div class="card"><p class="badge">Your result</p><h1>' + right + ' of ' + ROUNDS.length + ' right</h1><p class="result ' + (passed ? 'ok' : 'bad') + '">' + Math.round(scaled * 100) + '%</p><p>' +
      (passed ? 'Great eye for contrast!' : 'Tip: check colours with a contrast checker before you ship.') + '</p></div>';
  }
}
function answer(saysPasses) {
  var r = ROUNDS[state.round];
  var correct = saysPasses === r.ratio >= 4.5;
  state.answers.push(correct);
  send(verb('answered', 'answered'), {
    object: { objectType: 'Activity', id: activityId + '/round-' + (state.round + 1), definition: { name: { 'en-US': r.text }, type: 'http://adlnet.gov/expapi/activities/cmi.interaction', interactionType: 'true-false' } },
    result: { success: correct, response: String(saysPasses) },
    context: { registration: registration, contextActivities: { parent: [{ id: activityId }] } },
  });
  state.round++;
  saveState();
  if (state.round === ROUNDS.length) {
    var right = state.answers.filter(Boolean).length;
    var scaled = right / ROUNDS.length;
    var result = { score: { scaled: scaled, raw: right, min: 0, max: ROUNDS.length }, success: scaled >= 0.75, completion: true, duration: duration() };
    send(verb('completed', 'completed'), { result: result }).then(function () {
      return send(verb(result.success ? 'passed' : 'failed', result.success ? 'passed' : 'failed'), { result: result });
    });
  }
  render();
}
window.addEventListener('load', function () {
  if (!actor || !lrs.endpoint) {
    document.getElementById('app').innerHTML = '<div class="card"><h1>Colour contrast challenge</h1><p>Open this activity from your course to record your progress.</p></div>';
    return;
  }
  send(verb('launched', 'launched'));
  api(stateUrl()).then(function (res) { return res && res.ok ? res.json() : null; }).then(function (saved) {
    if (saved && typeof saved.round === 'number') state = saved;
    render();
  }, render);
});
window.addEventListener('pagehide', function () {
  var st = { actor: actor, verb: verb('terminated', 'terminated'), object: { objectType: 'Activity', id: activityId }, context: { registration: registration }, result: { duration: duration() } };
  if (lrs.endpoint) api('statements', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st) });
});
`;

const XAPI_INDEX = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Colour contrast challenge</title>
<link rel="stylesheet" href="style.css">
<script src="challenge.js"></script>
</head>
<body>
<main><header><span class="badge">Colour contrast challenge</span><span class="badge" style="color:#64748b">xAPI</span></header><div id="app" aria-live="polite"><p>Loading…</p></div></main>
</body>
</html>
`;

const TINCAN = `<?xml version="1.0" encoding="utf-8"?>
<tincan xmlns="http://projecttincan.com/tincan.xsd">
  <activities>
    <activity id="${DEMO_XAPI_ACTIVITY}" type="http://adlnet.gov/expapi/activities/course">
      <name>Colour contrast challenge</name>
      <description lang="en-US">Spot which colour pairs meet the WCAG 4.5:1 contrast ratio.</description>
      <launch lang="en-us">index.html</launch>
    </activity>
  </activities>
</tincan>
`;

export function accessibilityScormFiles(): Record<string, string> {
  return {
    'imsmanifest.xml': SCORM_MANIFEST,
    'index.html': SCORM_INDEX,
    'style.css': STYLE,
    'scorm.js': SCORM_WRAPPER,
    'module.js': MODULE_JS,
  };
}

export function contrastXapiFiles(): Record<string, string> {
  return { 'tincan.xml': TINCAN, 'index.html': XAPI_INDEX, 'style.css': STYLE, 'challenge.js': XAPI_JS };
}

export function zipFiles(files: Record<string, string | Uint8Array>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, typeof data === 'string' ? strToU8(data) : data])));
}
