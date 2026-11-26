/**
 * The demo cmi5 course, written by hand so the demo works offline: "Screen reader basics", one block with two
 * AUs that send real cmi5 statements through a small cmi5 client (lib/cmi5.js):
 *  - "How screen readers work" (moveOn Completed): three short pages, then "completed";
 *  - "Screen reader quiz" (moveOn Passed, mastery score 0.75): four questions, then "passed" or "failed".
 * In Browse and Review mode both AUs only send "initialized" and "terminated", as the specification asks.
 */
import { strToU8, zipSync } from 'fflate';

export const DEMO_CMI5 = {
  course: 'https://coursekit.test/cmi5/screen-reader-basics',
  block: 'https://coursekit.test/cmi5/screen-reader-basics/block/screen-readers',
  reading: 'https://coursekit.test/cmi5/screen-reader-basics/au/how-screen-readers-work',
  quiz: 'https://coursekit.test/cmi5/screen-reader-basics/au/screen-reader-quiz',
  objective: 'https://coursekit.test/cmi5/screen-reader-basics/objective/present-a-page',
};

const CMI5_XML = `<?xml version="1.0" encoding="UTF-8"?>
<courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd">
  <course id="${DEMO_CMI5.course}">
    <title><langstring lang="en-US">Screen reader basics</langstring></title>
    <description><langstring lang="en-US">How blind and low-vision people use the web with a screen reader, and what that means for your designs.</langstring></description>
  </course>
  <objectives>
    <objective id="${DEMO_CMI5.objective}">
      <title><langstring lang="en-US">Design pages that work with a screen reader</langstring></title>
      <description><langstring lang="en-US">Explain how a screen reader presents a page and write headings, links and alt text that help.</langstring></description>
    </objective>
  </objectives>
  <block id="${DEMO_CMI5.block}">
    <title><langstring lang="en-US">Screen readers</langstring></title>
    <description><langstring lang="en-US">A short reading and a quiz.</langstring></description>
    <objectives><objective idref="${DEMO_CMI5.objective}"/></objectives>
    <au id="${DEMO_CMI5.reading}" moveOn="Completed" launchMethod="AnyWindow">
      <title><langstring lang="en-US">How screen readers work</langstring></title>
      <description><langstring lang="en-US">Three short pages: what a screen reader does, how people move around a page, and how to write for it.</langstring></description>
      <objectives><objective idref="${DEMO_CMI5.objective}"/></objectives>
      <url>reading/index.html</url>
    </au>
    <au id="${DEMO_CMI5.quiz}" moveOn="Passed" masteryScore="0.75" launchMethod="AnyWindow">
      <title><langstring lang="en-US">Screen reader quiz</langstring></title>
      <description><langstring lang="en-US">Four questions. Get three right to pass.</langstring></description>
      <objectives><objective idref="${DEMO_CMI5.objective}"/></objectives>
      <url>quiz/index.html</url>
      <launchParameters>{"questions":4}</launchParameters>
    </au>
  </block>
</courseStructure>
`;

const STYLE = `*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1e1b4b;background:#f8fafc}
main{max-width:760px;margin:0 auto;padding:32px 24px 48px}header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:24px}
.badge{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#0f766e}h1{font-size:28px;line-height:1.25;margin:4px 0 16px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.progress{height:6px;background:#ccfbf1;border-radius:99px;overflow:hidden;margin-bottom:24px}.progress span{display:block;height:100%;background:#0f766e;transition:width .3s}
nav{display:flex;justify-content:space-between;flex-wrap:wrap;margin-top:24px;gap:12px}button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:10px 18px;cursor:pointer;background:#0f766e;color:#fff}
button.secondary{background:#ccfbf1;color:#134e4a}button:disabled{opacity:.5;cursor:default}button:focus-visible,label:focus-within{outline:3px solid #f59e0b;outline-offset:2px}
fieldset{border:0;margin:0 0 20px;padding:0}legend{font-weight:600;margin-bottom:8px}label{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:8px;cursor:pointer}
.tip{background:#f0fdfa;border-left:4px solid #0f766e;padding:12px 16px;border-radius:8px}.note{color:#64748b;font-size:14px}.result{font-size:48px;font-weight:700;margin:8px 0}.ok{color:#047857}.bad{color:#b91c1c}
.error{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:10px;padding:12px 16px;margin-top:16px}`;

/** A small cmi5 AU client: launch parameters, fetch URL, LMS.LaunchData, learner preferences and statements. */
const CMI5_JS = `var Cmi5 = (function () {
  var params = new URLSearchParams(location.search);
  var endpoint = params.get('endpoint');
  var fetchUrl = params.get('fetch');
  var registration = params.get('registration');
  var activityId = params.get('activityId');
  var actor = null;
  try { actor = JSON.parse(params.get('actor')); } catch (e) {}
  var CMI5 = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';
  var MOVE_ON = 'https://w3id.org/xapi/cmi5/context/categories/moveon';
  var MASTERY = 'https://w3id.org/xapi/cmi5/context/extensions/masteryscore';
  var auth = null, launchData = null, preferences = {}, started = Date.now(), terminated = false;

  function uuid() {
    if (window.crypto && crypto.randomUUID) { try { return crypto.randomUUID(); } catch (e) {} }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 3) | 8).toString(16);
    });
  }
  function lrs(path, options) {
    options = options || {};
    options.headers = Object.assign({ Authorization: auth, 'X-Experience-API-Version': '1.0.3' }, options.headers || {});
    return fetch(endpoint.replace(/\\/?$/, '/') + path, options);
  }
  function agent() { return encodeURIComponent(JSON.stringify(actor)); }
  function duration() { return 'PT' + Math.max(1, Math.round((Date.now() - started) / 1000)) + 'S'; }
  function context(categories, extensions) {
    var template = (launchData && launchData.contextTemplate) || {};
    var activities = JSON.parse(JSON.stringify(template.contextActivities || {}));
    activities.category = (activities.category || []).concat(categories.map(function (id) { return { id: id }; }));
    return { registration: registration, contextActivities: activities, extensions: Object.assign({}, template.extensions || {}, extensions || {}) };
  }
  function statement(verb, extra) {
    extra = extra || {};
    var st = {
      id: uuid(),
      timestamp: new Date().toISOString(),
      actor: actor,
      verb: { id: verb.indexOf(':') > 0 ? verb : 'http://adlnet.gov/expapi/verbs/' + verb, display: { 'en-US': verb.split('/').pop() } },
      object: extra.object || { objectType: 'Activity', id: activityId },
      context: context(extra.categories || [CMI5], extra.extensions),
    };
    if (extra.result) st.result = extra.result;
    return st;
  }
  function send(st, keepalive) {
    return lrs('statements', { method: 'POST', keepalive: !!keepalive, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st) }).then(function (res) {
      if (!res.ok) return res.json().then(function (body) { throw new Error((body && body.error && body.error.message) || 'The LMS refused a statement.'); });
      return res;
    });
  }
  var api = {
    available: function () { return !!(endpoint && fetchUrl && actor && registration && activityId); },
    start: function () {
      return fetch(fetchUrl, { method: 'POST' }).then(function (res) { return res.json(); }).then(function (body) {
        if (!body['auth-token']) throw new Error(body['error-text'] || 'The LMS did not give this lesson its credentials.');
        auth = 'Basic ' + body['auth-token'];
        return lrs('activities/state?stateId=LMS.LaunchData&activityId=' + encodeURIComponent(activityId) + '&agent=' + agent() + '&registration=' + registration);
      }).then(function (res) {
        if (!res.ok) throw new Error('The LMS launch data could not be read.');
        return res.json();
      }).then(function (data) {
        launchData = data;
        return lrs('agents/profile?profileId=cmi5LearnerPreferences&agent=' + agent()).then(function (res) { return res.ok ? res.json() : {}; }, function () { return {}; });
      }).then(function (prefs) {
        preferences = prefs || {};
        return send(statement('initialized'));
      });
    },
    mode: function () { return (launchData && launchData.launchMode) || 'Normal'; },
    recording: function () { return api.mode() === 'Normal'; },
    masteryScore: function () { return launchData && typeof launchData.masteryScore === 'number' ? launchData.masteryScore : null; },
    launchParameters: function () { return (launchData && launchData.launchParameters) || ''; },
    preferences: function () { return preferences; },
    completed: function () {
      if (!api.recording()) return Promise.resolve();
      return send(statement('completed', { categories: [CMI5, MOVE_ON], result: { completion: true, duration: duration() } }));
    },
    scored: function (right, total) {
      if (!api.recording()) return Promise.resolve();
      var scaled = Math.round((right / total) * 10000) / 10000;
      var mastery = api.masteryScore();
      var passed = mastery === null ? scaled >= 0.5 : scaled >= mastery;
      var extensions = {};
      if (mastery !== null) extensions[MASTERY] = mastery;
      return send(statement(passed ? 'passed' : 'failed', {
        categories: [CMI5, MOVE_ON],
        extensions: extensions,
        result: { score: { scaled: scaled, raw: right, min: 0, max: total }, success: passed, duration: duration() },
      }));
    },
    answered: function (id, text, response, correct) {
      return send(statement('answered', {
        categories: [],
        object: { objectType: 'Activity', id: activityId + '/' + id, definition: { name: { 'en-US': text }, type: 'http://adlnet.gov/expapi/activities/cmi.interaction', interactionType: 'choice' } },
        result: { response: String(response), success: !!correct },
      })).catch(function () {});
    },
    terminate: function (keepalive) {
      if (terminated || !auth) return Promise.resolve();
      terminated = true;
      return send(statement('terminated', { result: { duration: duration() } }), keepalive).catch(function () {});
    },
    exit: function () {
      return api.terminate().then(function () {
        if (launchData && launchData.returnURL) location.href = launchData.returnURL;
      });
    },
  };
  window.addEventListener('pagehide', function () { api.terminate(true); });
  return api;
})();
`;

const READING_JS = `var PAGES = [
  { title: 'What a screen reader does', html: '<p>A screen reader turns what is on the screen into speech or braille. It reads the text, and it also announces what things <em>are</em>: a heading, a link, a button, a checkbox that is ticked.</p><p>Popular screen readers are <strong>NVDA</strong> and <strong>JAWS</strong> on Windows, <strong>VoiceOver</strong> on macOS and iOS, and <strong>TalkBack</strong> on Android.</p><p class="tip">A screen reader can only announce what your code says. A <code>div</code> that looks like a button is announced as plain text.</p>' },
  { title: 'How people move around a page', html: '<p>Few people listen to a page from top to bottom. Most jump around with the keyboard:</p><ul><li>from <strong>heading</strong> to heading (the H key in many screen readers),</li><li>between <strong>landmarks</strong> such as the navigation and the main content,</li><li>through a list of every <strong>link</strong> on the page,</li><li>from one form <strong>control</strong> to the next with Tab.</li></ul><p class="tip">Clear headings in a logical order are the table of contents of your page.</p>' },
  { title: 'Writing for screen readers', html: '<ul><li>Write <strong>link text</strong> that makes sense on its own: "Download the annual report (PDF)", not "click here".</li><li>Give meaningful images an <strong>alt text</strong> that says what they show or do, and decorative images an empty <code>alt=""</code>.</li><li>Give every form field a visible <strong>label</strong>.</li><li>Announce changes that happen without a page load, like "3 results found", with a live region.</li></ul><p>That is it! Finish the reading, then try the quiz.</p>' },
];
var page = 0;
function render(error) {
  var p = PAGES[page];
  var last = page === PAGES.length - 1;
  document.getElementById('app').innerHTML = '<div class="progress" aria-hidden="true"><span style="width:' + Math.round(((page + 1) / PAGES.length) * 100) + '%"></span></div>' +
    '<div class="card"><p class="badge">Page ' + (page + 1) + ' of ' + PAGES.length + '</p><h1>' + p.title + '</h1>' + p.html +
    (Cmi5.recording() ? '' : '<p class="note">' + (Cmi5.mode() === 'Review' ? 'You are reviewing this reading: nothing is recorded.' : 'Preview: nothing is recorded.') + '</p>') +
    (error ? '<p class="error" role="alert">' + error + '</p>' : '') +
    '<nav><button class="secondary" id="prev"' + (page === 0 ? ' disabled' : '') + '>Previous</button><button id="next">' + (last ? 'Finish' : 'Next') + '</button></nav></div>';
  document.getElementById('prev').onclick = function () { page--; render(); window.scrollTo(0, 0); };
  document.getElementById('next').onclick = function () {
    if (!last) { page++; render(); window.scrollTo(0, 0); return; }
    this.disabled = true;
    Cmi5.completed().then(function () { return Cmi5.exit(); }, function (err) { render(err.message); });
  };
}
window.addEventListener('load', function () {
  if (!Cmi5.available()) {
    document.getElementById('app').innerHTML = '<div class="card"><h1>How screen readers work</h1><p>Open this lesson from your course to record your progress.</p></div>';
    return;
  }
  Cmi5.start().then(function () { render(); }, function (err) {
    document.getElementById('app').innerHTML = '<div class="card"><h1>How screen readers work</h1><p class="error" role="alert">' + err.message + '</p></div>';
  });
});
`;

const QUIZ_JS = `var QUESTIONS = [
  { id: 'q1', text: 'Which screen reader is built into macOS and iOS?', options: ['NVDA', 'VoiceOver', 'TalkBack', 'JAWS'], answer: 1 },
  { id: 'q2', text: 'How do many screen reader users find their way around a long page?', options: ['They listen from the top to the bottom', 'They jump from heading to heading', 'They scroll with the mouse', 'They zoom in'], answer: 1 },
  { id: 'q3', text: 'Which link text works best for a screen reader user?', options: ['Click here', 'Read more', 'Download the annual report (PDF)', 'Link'], answer: 2 },
  { id: 'q4', text: 'What alt text should an image that only decorates the page have?', options: ['An empty alt attribute (alt="")', 'The word "image"', 'No alt attribute at all', 'The file name'], answer: 0 },
];
var answers = {};
function render(error) {
  var html = '<div class="card"><p class="badge">Quiz</p><h1>Screen reader quiz</h1><p>Get three of the four questions right to pass.</p><form id="quiz">';
  QUESTIONS.forEach(function (q, i) {
    html += '<fieldset><legend>' + (i + 1) + '. ' + q.text + '</legend>';
    q.options.forEach(function (o, j) {
      html += '<label><input type="radio" name="' + q.id + '" value="' + j + '"' + (answers[q.id] === j ? ' checked' : '') + '> <span>' + o.replace(/</g, '&lt;') + '</span></label>';
    });
    html += '</fieldset>';
  });
  html += (Cmi5.recording() ? '' : '<p class="note">' + (Cmi5.mode() === 'Review' ? 'You already passed: this is a review and nothing is recorded.' : 'Preview: nothing is recorded.') + '</p>') +
    (error ? '<p class="error" role="alert">' + error + '</p>' : '') + '<nav><span></span><button type="submit">Submit answers</button></nav></form></div>';
  document.getElementById('app').innerHTML = html;
  var form = document.getElementById('quiz');
  form.onchange = function (e) { answers[e.target.name] = Number(e.target.value); };
  form.onsubmit = function (e) { e.preventDefault(); submit(); };
}
function submit() {
  var missing = QUESTIONS.filter(function (q) { return answers[q.id] === undefined; }).length;
  if (missing) { render('Answer every question first (' + missing + ' left).'); return; }
  var right = 0;
  var sent = QUESTIONS.map(function (q) {
    var correct = answers[q.id] === q.answer;
    if (correct) right++;
    return Cmi5.answered(q.id, q.text, answers[q.id], correct);
  });
  var mastery = Cmi5.masteryScore() === null ? 0.75 : Cmi5.masteryScore();
  var passed = right / QUESTIONS.length >= mastery;
  Promise.all(sent).then(function () { return Cmi5.scored(right, QUESTIONS.length); }).then(function () {
    document.getElementById('app').innerHTML = '<div class="card"><p class="badge">Your result</p><h1>' + (passed ? 'Well done!' : 'Nearly there') + '</h1><p class="result ' + (passed ? 'ok' : 'bad') + '">' + right + ' of ' + QUESTIONS.length + '</p><p>' +
      (passed ? 'You know how screen readers present a page.' : 'Read "How screen readers work" again, then try the quiz once more.') + '</p><nav><span></span><button id="done">Back to the course</button></nav></div>';
    document.getElementById('done').onclick = function () { this.disabled = true; Cmi5.exit(); };
  }, function (err) { render(err.message); });
}
window.addEventListener('load', function () {
  if (!Cmi5.available()) {
    document.getElementById('app').innerHTML = '<div class="card"><h1>Screen reader quiz</h1><p>Open this quiz from your course to record your result.</p></div>';
    return;
  }
  Cmi5.start().then(function () { render(); }, function (err) {
    document.getElementById('app').innerHTML = '<div class="card"><h1>Screen reader quiz</h1><p class="error" role="alert">' + err.message + '</p></div>';
  });
});
`;

const page = (title: string, script: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="../lib/style.css">
<script src="../lib/cmi5.js"></script>
<script src="${script}"></script>
</head>
<body>
<main><header><span class="badge">Screen reader basics</span><span class="badge" style="color:#64748b">cmi5</span></header><div id="app" aria-live="polite"><p>Loading…</p></div></main>
</body>
</html>
`;

export function screenReaderCmi5Files(): Record<string, string> {
  return {
    'cmi5.xml': CMI5_XML,
    'lib/cmi5.js': CMI5_JS,
    'lib/style.css': STYLE,
    'reading/index.html': page('How screen readers work', 'reading.js'),
    'reading/reading.js': READING_JS,
    'quiz/index.html': page('Screen reader quiz', 'quiz.js'),
    'quiz/quiz.js': QUIZ_JS,
  };
}

export function screenReaderCmi5Zip(): Uint8Array {
  const files = screenReaderCmi5Files();
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, strToU8(data)])));
}
