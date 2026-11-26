// @ts-nocheck
/**
 * The SCORM run-time that Coursekit serves to every HTML page of a package (as /__coursekit/runtime.js,
 * loaded first in <head>). It defines window.API (SCORM 1.2) and window.API_1484_11 (SCORM 2004) on
 * top of a data model that works synchronously on the state the server embedded, sends changes back
 * with fetch (keepalive) and navigator.sendBeacon, installs in-memory localStorage, sessionStorage and
 * document.cookie when the sandbox (an opaque origin) makes the real ones throw, and tells the Coursekit
 * page about progress with postMessage.
 *
 * The server runs the same data model (`packageRuntime(null)`) to re-validate every commit, so this
 * function must stay self-contained: it is serialised with Function.prototype.toString(). Plain ES2017,
 * no imports, no references to anything outside the function.
 */
export function packageRuntime(win, boot) {
  'use strict';

  var OK = '';
  var RE_DEC = /^[-+]?(\d+(\.\d*)?|\.\d+)$/;
  var RE_INT = /^-?\d+$/;
  var RE_TIMESPAN = /^\d{2,4}:\d{2}:\d{2}(\.\d{1,2})?$/;
  var RE_TIME12 = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,2})?$/;
  var RE_DURATION = /^P(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d{1,2})?S)?)?$/;
  var RE_TIME = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2})(?::(\d{2})(?::(\d{2})(?:\.\d{1,2})?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?)?)?$/;
  var RE_LANG = /^([a-zA-Z]{2,3}|i|x)(-[a-zA-Z0-9]{1,8})*$/;
  var RE_SHORT_ID = /^\S{1,250}$/;

  function vocab(list) {
    return function (v) {
      return list.indexOf(v) >= 0 ? OK : 'TYPE';
    };
  }
  function str(max) {
    return function (v) {
      return v.length <= max ? OK : 'TOOBIG';
    };
  }
  function number(min, max, integer, blank) {
    return function (v) {
      if (blank && v === '') return OK;
      if (!(integer ? RE_INT : RE_DEC).test(v)) return 'TYPE';
      var n = Number(v);
      if ((min !== null && n < min) || (max !== null && n > max)) return 'RANGE';
      return OK;
    };
  }
  function either(a, b) {
    return function (v, ctx) {
      return a(v, ctx) === OK ? OK : b(v, ctx);
    };
  }
  function id12(v) {
    return /^\S{1,255}$/.test(v) ? OK : 'TYPE';
  }
  function longId(v) {
    if (v.length > 4000) return 'TOOBIG';
    return /^\S+$/.test(v) ? OK : 'TYPE';
  }
  function timespan(v) {
    return RE_TIMESPAN.test(v) ? OK : 'TYPE';
  }
  function time12(v) {
    return RE_TIME12.test(v) ? OK : 'TYPE';
  }
  function duration(v) {
    return RE_DURATION.test(v) ? OK : 'TYPE';
  }
  function time(v) {
    var m = RE_TIME.exec(v);
    if (!m) return 'TYPE';
    var y = +m[1];
    if (y < 1970 || y > 2038) return 'TYPE';
    if (m[2] !== undefined && (+m[2] < 1 || +m[2] > 12)) return 'TYPE';
    if (m[3] !== undefined && (+m[3] < 1 || +m[3] > 31)) return 'TYPE';
    if (m[4] !== undefined && +m[4] > 23) return 'TYPE';
    if (m[5] !== undefined && +m[5] > 59) return 'TYPE';
    if (m[6] !== undefined && +m[6] > 59) return 'TYPE';
    return OK;
  }
  /** Strips a {lang=xx} delimiter. Returns null when the delimiter is malformed. */
  function stripLang(v) {
    if (v.indexOf('{lang=') !== 0) return v;
    var end = v.indexOf('}');
    if (end < 0) return null;
    var lang = v.slice(6, end);
    if (!RE_LANG.test(lang)) return null;
    return v.slice(end + 1);
  }
  function localized(max) {
    return function (v) {
      var rest = stripLang(v);
      if (rest === null) return 'TYPE';
      return rest.length <= max ? OK : 'TOOBIG';
    };
  }
  function language(v) {
    if (v.length > 250) return 'TOOBIG';
    return v === '' || RE_LANG.test(v) ? OK : 'TYPE';
  }
  function navRequest(v) {
    if (['continue', 'previous', 'choice', 'jump', 'exit', 'exitAll', 'abandon', 'abandonAll', 'suspendAll', '_none_'].indexOf(v) >= 0) {
      return OK;
    }
    return /^\{target=[^}\s]+\}(choice|jump)$/.test(v) ? OK : 'TYPE';
  }

  /** Strips {case_matters=..} and {order_matters=..} delimiters from the start of a pattern. */
  function stripFlags(v, allowed) {
    var re = /^\{(case_matters|order_matters)=(true|false)\}/;
    var m;
    while ((m = re.exec(v))) {
      if (allowed.indexOf(m[1]) < 0) return null;
      v = v.slice(m[0].length);
    }
    return v;
  }
  function list(v) {
    return v === '' ? [] : v.split('[,]');
  }
  function unique(items) {
    for (var i = 0; i < items.length; i++) if (items.indexOf(items[i]) !== i) return false;
    return true;
  }
  function pairs(v, requireBoth) {
    var items = list(v);
    for (var i = 0; i < items.length; i++) {
      var p = items[i].split('[.]');
      if (p.length !== 2) return false;
      if (requireBoth ? !RE_SHORT_ID.test(p[0]) || !RE_SHORT_ID.test(p[1]) : p[0] === '' && p[1] === '') return false;
      if (!requireBoth && p[0] !== '' && !RE_SHORT_ID.test(p[0])) return false;
    }
    return items.length > 0;
  }
  /** SCORM 2004 learner_response (isPattern: correct_responses.n.pattern) for an interaction type. */
  function responseFor(type, v, isPattern) {
    var rest;
    switch (type) {
      case 'true-false':
        return v === 'true' || v === 'false';
      case 'choice':
      case 'sequencing': {
        var ids = list(v);
        for (var i = 0; i < ids.length; i++) if (!RE_SHORT_ID.test(ids[i])) return false;
        return type === 'sequencing' ? ids.length > 0 : unique(ids);
      }
      case 'fill-in': {
        rest = isPattern ? stripFlags(v, ['case_matters', 'order_matters']) : v;
        if (rest === null) return false;
        var parts = list(rest);
        if (parts.length > 10) return false;
        for (var j = 0; j < parts.length; j++) {
          var s = stripLang(parts[j]);
          if (s === null || s.length > 250) return false;
        }
        return true;
      }
      case 'long-fill-in':
        rest = isPattern ? stripFlags(v, ['case_matters']) : v;
        if (rest === null) return false;
        rest = stripLang(rest);
        return rest !== null && rest.length <= 4000;
      case 'matching':
        return pairs(v, true);
      case 'performance':
        rest = isPattern ? stripFlags(v, ['order_matters']) : v;
        return rest !== null && pairs(rest, false);
      case 'likert':
        return RE_SHORT_ID.test(v);
      case 'numeric':
        if (!isPattern) return RE_DEC.test(v);
        if (RE_DEC.test(v)) return true;
        var range = v.split('[:]');
        if (range.length !== 2) return false;
        if ((range[0] !== '' && !RE_DEC.test(range[0])) || (range[1] !== '' && !RE_DEC.test(range[1]))) return false;
        return range[0] === '' || range[1] === '' || Number(range[0]) <= Number(range[1]);
      default:
        return v.length <= 4000;
    }
  }
  /** Most correct_responses a SCORM 2004 interaction type may have. */
  var PATTERN_LIMITS = {
    'true-false': 1,
    choice: 10,
    'fill-in': 5,
    'long-fill-in': 5,
    matching: 5,
    performance: 5,
    sequencing: 5,
    likert: 1,
    numeric: 1,
    other: 1,
  };

  var STATUS12 = ['passed', 'completed', 'failed', 'incomplete', 'browsed', 'not attempted'];
  var COMPLETION = ['completed', 'incomplete', 'not attempted', 'unknown'];
  var SUCCESS = ['passed', 'failed', 'unknown'];
  var score12 = number(0, 100, false, true);
  var real = number(null, null, false, false);

  // m: ro | rw | wo; t: validator; d: default; lms: value supplied by Coursekit; kids: _children;
  // arr: an array (max entries, needsId: the id must be set first).
  var MODEL_12 = {
    'cmi._version': { m: 'ro', d: '3.4' },
    'cmi.core': {
      kids: 'student_id,student_name,lesson_location,credit,lesson_status,entry,score,total_time,lesson_mode,exit,session_time',
    },
    'cmi.core.student_id': { m: 'ro', lms: 1 },
    'cmi.core.student_name': { m: 'ro', lms: 1 },
    'cmi.core.lesson_location': { m: 'rw', t: str(255), d: '' },
    'cmi.core.credit': { m: 'ro', lms: 1 },
    'cmi.core.lesson_status': { m: 'rw', t: vocab(STATUS12.slice(0, 5)), d: 'not attempted' },
    'cmi.core.entry': { m: 'ro', lms: 1 },
    'cmi.core.score': { kids: 'raw,min,max' },
    'cmi.core.score.raw': { m: 'rw', t: score12, d: '' },
    'cmi.core.score.min': { m: 'rw', t: score12, d: '' },
    'cmi.core.score.max': { m: 'rw', t: score12, d: '' },
    'cmi.core.total_time': { m: 'ro', lms: 1 },
    'cmi.core.lesson_mode': { m: 'ro', lms: 1 },
    'cmi.core.exit': { m: 'wo', t: vocab(['time-out', 'suspend', 'logout', '']) },
    'cmi.core.session_time': { m: 'wo', t: timespan },
    'cmi.suspend_data': { m: 'rw', t: str(4096), d: '' },
    'cmi.launch_data': { m: 'ro', lms: 1 },
    'cmi.comments': { m: 'rw', t: str(4096), d: '' },
    'cmi.comments_from_lms': { m: 'ro', lms: 1 },
    'cmi.objectives': { arr: 100, kids: 'id,score,status' },
    'cmi.objectives.#.id': { m: 'rw', t: id12, d: '' },
    'cmi.objectives.#.score': { kids: 'raw,min,max' },
    'cmi.objectives.#.score.raw': { m: 'rw', t: score12, d: '' },
    'cmi.objectives.#.score.min': { m: 'rw', t: score12, d: '' },
    'cmi.objectives.#.score.max': { m: 'rw', t: score12, d: '' },
    'cmi.objectives.#.status': { m: 'rw', t: vocab(STATUS12), d: 'not attempted' },
    'cmi.student_data': { kids: 'mastery_score,max_time_allowed,time_limit_action' },
    'cmi.student_data.mastery_score': { m: 'ro', lms: 1 },
    'cmi.student_data.max_time_allowed': { m: 'ro', lms: 1 },
    'cmi.student_data.time_limit_action': { m: 'ro', lms: 1 },
    'cmi.student_preference': { kids: 'audio,language,speed,text' },
    'cmi.student_preference.audio': { m: 'rw', t: number(-1, 100, true), d: '0' },
    'cmi.student_preference.language': { m: 'rw', t: str(255), d: '' },
    'cmi.student_preference.speed': { m: 'rw', t: number(-100, 100, true), d: '0' },
    'cmi.student_preference.text': { m: 'rw', t: number(-1, 1, true), d: '0' },
    'cmi.interactions': { arr: 250, kids: 'id,objectives,time,type,correct_responses,weighting,student_response,result,latency' },
    'cmi.interactions.#.id': { m: 'wo', t: id12 },
    'cmi.interactions.#.objectives': { arr: 50, kids: 'id' },
    'cmi.interactions.#.objectives.#.id': { m: 'wo', t: id12 },
    'cmi.interactions.#.time': { m: 'wo', t: time12 },
    'cmi.interactions.#.type': {
      m: 'wo',
      t: vocab(['true-false', 'choice', 'fill-in', 'matching', 'performance', 'sequencing', 'likert', 'numeric']),
    },
    'cmi.interactions.#.correct_responses': { arr: 50, kids: 'pattern' },
    'cmi.interactions.#.correct_responses.#.pattern': { m: 'wo', t: str(255) },
    'cmi.interactions.#.weighting': { m: 'wo', t: real },
    'cmi.interactions.#.student_response': { m: 'wo', t: str(255) },
    'cmi.interactions.#.result': { m: 'wo', t: either(vocab(['correct', 'wrong', 'unanticipated', 'neutral']), real) },
    'cmi.interactions.#.latency': { m: 'wo', t: timespan },
  };

  var MODEL_2004 = {
    'cmi._version': { m: 'ro', d: '1.0' },
    'cmi.comments_from_learner': { arr: 250, kids: 'comment,location,timestamp' },
    'cmi.comments_from_learner.#.comment': { m: 'rw', t: localized(4000) },
    'cmi.comments_from_learner.#.location': { m: 'rw', t: str(250) },
    'cmi.comments_from_learner.#.timestamp': { m: 'rw', t: time },
    'cmi.comments_from_lms': { arr: 0, ro: 1, kids: 'comment,location,timestamp' },
    'cmi.comments_from_lms.#.comment': { m: 'ro' },
    'cmi.comments_from_lms.#.location': { m: 'ro' },
    'cmi.comments_from_lms.#.timestamp': { m: 'ro' },
    'cmi.completion_status': { m: 'rw', t: vocab(COMPLETION), d: 'unknown' },
    'cmi.completion_threshold': { m: 'ro', lms: 1 },
    'cmi.credit': { m: 'ro', lms: 1 },
    'cmi.entry': { m: 'ro', lms: 1 },
    'cmi.exit': { m: 'wo', t: vocab(['time-out', 'suspend', 'logout', 'normal', '']) },
    'cmi.interactions': {
      arr: 250,
      needsId: 1,
      kids: 'id,type,objectives,timestamp,correct_responses,weighting,learner_response,result,latency,description',
    },
    'cmi.interactions.#.id': { m: 'rw', t: longId },
    'cmi.interactions.#.type': {
      m: 'rw',
      t: vocab(['true-false', 'choice', 'fill-in', 'long-fill-in', 'matching', 'performance', 'sequencing', 'likert', 'numeric', 'other']),
    },
    'cmi.interactions.#.objectives': { arr: 50, needsId: 1, kids: 'id' },
    'cmi.interactions.#.objectives.#.id': { m: 'rw', t: longId },
    'cmi.interactions.#.timestamp': { m: 'rw', t: time },
    'cmi.interactions.#.correct_responses': { arr: 10, kids: 'pattern' },
    'cmi.interactions.#.correct_responses.#.pattern': { m: 'rw', t: str(8000) },
    'cmi.interactions.#.weighting': { m: 'rw', t: real },
    'cmi.interactions.#.learner_response': { m: 'rw', t: str(8000) },
    'cmi.interactions.#.result': { m: 'rw', t: either(vocab(['correct', 'incorrect', 'unanticipated', 'neutral']), real) },
    'cmi.interactions.#.latency': { m: 'rw', t: duration },
    'cmi.interactions.#.description': { m: 'rw', t: localized(250) },
    'cmi.launch_data': { m: 'ro', lms: 1 },
    'cmi.learner_id': { m: 'ro', lms: 1 },
    'cmi.learner_name': { m: 'ro', lms: 1 },
    'cmi.learner_preference': { kids: 'audio_level,language,delivery_speed,audio_captioning' },
    'cmi.learner_preference.audio_level': { m: 'rw', t: number(0, null), d: '1' },
    'cmi.learner_preference.language': { m: 'rw', t: language, d: '' },
    'cmi.learner_preference.delivery_speed': { m: 'rw', t: number(0, null), d: '1' },
    'cmi.learner_preference.audio_captioning': { m: 'rw', t: vocab(['-1', '0', '1']), d: '0' },
    'cmi.location': { m: 'rw', t: str(1000) },
    'cmi.max_time_allowed': { m: 'ro', lms: 1 },
    'cmi.mode': { m: 'ro', lms: 1 },
    'cmi.objectives': { arr: 100, needsId: 1, kids: 'id,score,success_status,completion_status,progress_measure,description' },
    'cmi.objectives.#.id': { m: 'rw', t: longId },
    'cmi.objectives.#.score': { kids: 'scaled,raw,min,max' },
    'cmi.objectives.#.score.scaled': { m: 'rw', t: number(-1, 1) },
    'cmi.objectives.#.score.raw': { m: 'rw', t: real },
    'cmi.objectives.#.score.min': { m: 'rw', t: real },
    'cmi.objectives.#.score.max': { m: 'rw', t: real },
    'cmi.objectives.#.success_status': { m: 'rw', t: vocab(SUCCESS), d: 'unknown' },
    'cmi.objectives.#.completion_status': { m: 'rw', t: vocab(COMPLETION), d: 'unknown' },
    'cmi.objectives.#.progress_measure': { m: 'rw', t: number(0, 1) },
    'cmi.objectives.#.description': { m: 'rw', t: localized(250) },
    'cmi.progress_measure': { m: 'rw', t: number(0, 1) },
    'cmi.scaled_passing_score': { m: 'ro', lms: 1 },
    'cmi.score': { kids: 'scaled,raw,min,max' },
    'cmi.score.scaled': { m: 'rw', t: number(-1, 1) },
    'cmi.score.raw': { m: 'rw', t: real },
    'cmi.score.min': { m: 'rw', t: real },
    'cmi.score.max': { m: 'rw', t: real },
    'cmi.session_time': { m: 'wo', t: duration },
    'cmi.success_status': { m: 'rw', t: vocab(SUCCESS), d: 'unknown' },
    'cmi.suspend_data': { m: 'rw', t: str(64000) },
    'cmi.time_limit_action': { m: 'ro', lms: 1 },
    'cmi.total_time': { m: 'ro', lms: 1 },
    'adl.nav.request': { m: 'rw', t: navRequest, d: '_none_' },
    'adl.nav.request_valid.continue': { m: 'ro', nav: 'continue' },
    'adl.nav.request_valid.previous': { m: 'ro', nav: 'previous' },
    'adl.data': { arr: 0, ro: 1, kids: 'id,store' },
    'adl.data.#.id': { m: 'ro' },
    'adl.data.#.store': { m: 'rw', t: str(64000) },
  };

  var CODES = {
    '1.2': {
      UNDEF: '201',
      NOTIMPL: '401',
      RO: '403',
      WO: '404',
      TYPE: '405',
      RANGE: '405',
      TOOBIG: '405',
      DEP: '201',
      SETFAIL: '201',
      GETFAIL: '201',
      CHILDREN: '202',
      COUNT: '203',
      KEYWORD: '402',
      FULL: '101',
    },
    2004: {
      UNDEF: '401',
      NOTIMPL: '402',
      NOTINIT: '403',
      RO: '404',
      WO: '405',
      TYPE: '406',
      RANGE: '407',
      TOOBIG: '351',
      DEP: '408',
      SETFAIL: '351',
      GETFAIL: '301',
      CHILDREN: '301',
      COUNT: '301',
      KEYWORD: '404',
      FULL: '351',
    },
  };

  var MESSAGES = {
    '1.2': {
      0: 'No error',
      101: 'General exception',
      201: 'Invalid argument error',
      202: 'Element cannot have children',
      203: 'Element not an array - cannot have count',
      301: 'Not initialized',
      401: 'Not implemented error',
      402: 'Invalid set value, element is a keyword',
      403: 'Element is read only',
      404: 'Element is write only',
      405: 'Incorrect data type',
    },
    2004: {
      0: 'No Error',
      101: 'General Exception',
      102: 'General Initialization Failure',
      103: 'Already Initialized',
      104: 'Content Instance Terminated',
      111: 'General Termination Failure',
      112: 'Termination Before Initialization',
      113: 'Termination After Termination',
      122: 'Retrieve Data Before Initialization',
      123: 'Retrieve Data After Termination',
      132: 'Store Data Before Initialization',
      133: 'Store Data After Termination',
      142: 'Commit Before Initialization',
      143: 'Commit After Termination',
      201: 'General Argument Error',
      301: 'General Get Failure',
      351: 'General Set Failure',
      391: 'General Commit Failure',
      401: 'Undefined Data Model Element',
      402: 'Unimplemented Data Model Element',
      403: 'Data Model Element Value Not Initialized',
      404: 'Data Model Element Is Read Only',
      405: 'Data Model Element Is Write Only',
      406: 'Data Model Element Type Mismatch',
      407: 'Data Model Element Value Out Of Range',
      408: 'Data Model Dependency Not Established',
    },
  };

  /**
   * A run-time data model. `version` is '1.2' or '2004'; `init` = { values, counts, lms, nav, maxBytes }.
   * get() returns { value, error } and set() returns an error kind ('' when it worked).
   */
  function createModel(version, init) {
    var defs = version === '1.2' ? MODEL_12 : MODEL_2004;
    var values = {};
    var counts = {};
    var lms = (init && init.lms) || {};
    var nav = (init && init.nav) || { items: [], index: 0 };
    var maxBytes = (init && init.maxBytes) || 512 * 1024;
    var bytes = 0;
    var k;
    if (init && init.values) for (k in init.values) if (typeof init.values[k] === 'string') values[k] = init.values[k];
    if (init && init.counts) for (k in init.counts) if (typeof init.counts[k] === 'number') counts[k] = init.counts[k];
    for (k in values) bytes += k.length + values[k].length;
    var order = [];
    var changed = {};

    function parse(element) {
      var parts = String(element).split('.');
      var pattern = [];
      var arrays = [];
      for (var i = 0; i < parts.length; i++) {
        if (/^\d+$/.test(parts[i]) && i > 0) {
          if (parts[i].length > 1 && parts[i][0] === '0') return null;
          arrays.push({ path: parts.slice(0, i).join('.'), pattern: pattern.join('.'), index: Number(parts[i]) });
          pattern.push('#');
        } else {
          pattern.push(parts[i]);
        }
      }
      return { pattern: pattern.join('.'), arrays: arrays };
    }
    function count(path, def) {
      if (def && def.ro) return 0;
      return counts[path] || 0;
    }
    /** Checks that every array the element sits in exists (for get), returns an error kind or ''. */
    function within(arrays, creating) {
      for (var i = 0; i < arrays.length; i++) {
        var a = arrays[i];
        var c = count(a.path, defs[a.pattern]);
        var last = i === arrays.length - 1;
        if (a.index < c) continue;
        if (creating && last && a.index === c) continue;
        return 'OUT';
      }
      return OK;
    }
    function lookupNav(element) {
      var m = /^adl\.nav\.request_valid\.(choice|jump)\.\{target=([^}]+)\}$/.exec(element);
      if (!m) return null;
      return nav.items.indexOf(m[2]) >= 0 ? 'true' : 'false';
    }
    function rawGet(element) {
      return Object.prototype.hasOwnProperty.call(values, element) ? values[element] : undefined;
    }
    function evaluated(element, stored) {
      if (version !== '2004') return stored;
      if (element === 'cmi.completion_status') {
        var threshold = lms['cmi.completion_threshold'];
        if (threshold !== undefined && threshold !== '') {
          var pm = rawGet('cmi.progress_measure');
          if (pm === undefined) return 'unknown';
          return Number(pm) >= Number(threshold) ? 'completed' : 'incomplete';
        }
      }
      if (element === 'cmi.success_status') {
        var passing = lms['cmi.scaled_passing_score'];
        if (passing !== undefined && passing !== '') {
          var scaled = rawGet('cmi.score.scaled');
          if (scaled === undefined) return 'unknown';
          return Number(scaled) >= Number(passing) ? 'passed' : 'failed';
        }
      }
      return stored;
    }

    function get(element) {
      element = String(element === undefined || element === null ? '' : element);
      if (element === '') return { value: '', error: 'GETFAIL' };
      var navValue = version === '2004' ? lookupNav(element) : null;
      if (navValue !== null) return { value: navValue, error: OK };
      var parts = element.split('.');
      var last = parts[parts.length - 1];
      if (last === '_children' || last === '_count') {
        var base = parse(parts.slice(0, -1).join('.'));
        var def = base && defs[base.pattern];
        if (!def) return { value: '', error: 'UNDEF' };
        if (base.arrays.length && within(base.arrays, false)) return { value: '', error: 'GETFAIL' };
        if (last === '_children') return def.kids ? { value: def.kids, error: OK } : { value: '', error: 'CHILDREN' };
        return def.arr !== undefined
          ? { value: String(count(parts.slice(0, -1).join('.'), def)), error: OK }
          : { value: '', error: 'COUNT' };
      }
      var p = parse(element);
      var d = p && defs[p.pattern];
      if (!d || !d.m) return { value: '', error: 'UNDEF' };
      if (d.m === 'wo') return { value: '', error: 'WO' };
      if (p.arrays.length && within(p.arrays, false)) return { value: '', error: 'GETFAIL' };
      if (d.nav) {
        var target = d.nav === 'continue' ? nav.index + 1 : nav.index - 1;
        return { value: target >= 0 && target < nav.items.length ? 'true' : 'false', error: OK };
      }
      var stored = d.lms ? lms[element] : rawGet(element);
      if (stored === undefined || stored === null) {
        if (d.d !== undefined) return { value: evaluated(element, d.d), error: OK };
        return { value: '', error: version === '2004' ? 'NOTINIT' : OK };
      }
      return { value: evaluated(element, String(stored)), error: OK };
    }

    function set(element, value) {
      element = String(element === undefined || element === null ? '' : element);
      if (element === '') return 'SETFAIL';
      if (value === undefined || value === null) value = '';
      if (typeof value !== 'string') value = String(value);
      var parts = element.split('.');
      var last = parts[parts.length - 1];
      if (last === '_version') return element === 'cmi._version' ? 'KEYWORD' : 'UNDEF';
      if (last === '_children' || last === '_count') {
        var base = parse(parts.slice(0, -1).join('.'));
        return base && defs[base.pattern] ? 'KEYWORD' : 'UNDEF';
      }
      if (version === '2004' && /^adl\.nav\.request_valid\./.test(element)) return lookupNav(element) !== null ? 'RO' : 'UNDEF';
      var p = parse(element);
      var d = p && defs[p.pattern];
      if (!d || !d.m) return 'UNDEF';
      if (d.m === 'ro') return 'RO';
      var arrays = p.arrays;
      var creating = false;
      if (arrays.length) {
        var own = arrays[arrays.length - 1];
        var ownDef = defs[own.pattern];
        if (within(arrays, true)) return 'SETFAIL';
        creating = own.index === count(own.path, ownDef);
        if (creating) {
          if (ownDef.ro || own.index >= ownDef.arr) return 'SETFAIL';
          if (version === '2004' && ownDef.needsId && last !== 'id') return 'DEP';
        }
      }
      var error = d.t ? d.t(value) : OK;
      if (error) return error;
      if (version === '1.2' && element === 'cmi.core.lesson_status' && value === 'not attempted') return 'TYPE';

      if (version === '2004') {
        var m = /^(cmi\.interactions\.\d+)\.(learner_response|correct_responses\.(\d+)\.pattern)$/.exec(element);
        if (m) {
          var type = rawGet(m[1] + '.type');
          if (type === undefined) return 'DEP';
          if (!responseFor(type, value, m[2] !== 'learner_response')) return 'TYPE';
          if (m[3] !== undefined && creating && Number(m[3]) >= (PATTERN_LIMITS[type] || 1)) return 'SETFAIL';
          if (m[3] !== undefined && type === 'choice') {
            for (var r = 0; r < count(m[1] + '.correct_responses'); r++) {
              if (r !== Number(m[3]) && rawGet(m[1] + '.correct_responses.' + r + '.pattern') === value) return 'SETFAIL';
            }
          }
        }
        var idMatch = /^(.*)\.(\d+)\.id$/.exec(element);
        if (idMatch && (idMatch[1] === 'cmi.objectives' || /^cmi\.interactions\.\d+\.objectives$/.test(idMatch[1]))) {
          var existing = rawGet(element);
          if (idMatch[1] === 'cmi.objectives' && existing !== undefined && existing !== value) return 'SETFAIL';
          var n = count(idMatch[1]);
          for (var o = 0; o < n; o++) {
            if (o !== Number(idMatch[2]) && rawGet(idMatch[1] + '.' + o + '.id') === value) return 'SETFAIL';
          }
        }
      }

      var previous = rawGet(element);
      var nextBytes = bytes - (previous === undefined ? 0 : element.length + previous.length) + element.length + value.length;
      if (nextBytes > maxBytes) return 'FULL';
      bytes = nextBytes;
      values[element] = value;
      if (creating) {
        var a = arrays[arrays.length - 1];
        counts[a.path] = a.index + 1;
      }
      if (!changed[element]) {
        changed[element] = true;
        order.push(element);
      }
      return OK;
    }

    return {
      get: get,
      set: set,
      values: values,
      counts: counts,
      /** The elements set so far, in the order they were first set, with their latest values. */
      changes: function () {
        var out = [];
        for (var i = 0; i < order.length; i++) out.push([order[i], values[order[i]]]);
        return out;
      },
    };
  }

  if (!win) return { createModel: createModel, codes: CODES, messages: MESSAGES };

  // ----- in the browser -----
  var doc = win.document;

  function memoryStorage() {
    var data = {};
    var store = {
      getItem: function (key) {
        key = String(key);
        return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
      },
      setItem: function (key, value) {
        data[String(key)] = String(value);
      },
      removeItem: function (key) {
        delete data[String(key)];
      },
      clear: function () {
        data = {};
      },
      key: function (i) {
        var keys = Object.keys(data);
        return i >= 0 && i < keys.length ? keys[i] : null;
      },
    };
    Object.defineProperty(store, 'length', {
      get: function () {
        return Object.keys(data).length;
      },
    });
    return store;
  }
  function ensureStorage(name) {
    var works = false;
    try {
      var s = win[name];
      s.setItem('__coursekit__', '1');
      s.removeItem('__coursekit__');
      works = true;
    } catch (e) {
      works = false;
    }
    if (!works) {
      try {
        Object.defineProperty(win, name, { configurable: true, enumerable: true, value: memoryStorage() });
      } catch (e) {
        // leave it
      }
    }
  }
  ensureStorage('localStorage');
  ensureStorage('sessionStorage');
  if (doc) {
    var cookieWorks = false;
    try {
      void doc.cookie;
      cookieWorks = true;
    } catch (e) {
      cookieWorks = false;
    }
    if (!cookieWorks) {
      var jar = {};
      try {
        Object.defineProperty(doc, 'cookie', {
          configurable: true,
          get: function () {
            var out = [];
            for (var name in jar) out.push(name + '=' + jar[name]);
            return out.join('; ');
          },
          set: function (raw) {
            var parts = String(raw).split(';');
            var pair = parts[0];
            var eq = pair.indexOf('=');
            var name = (eq < 0 ? '' : pair.slice(0, eq)).trim();
            var value = (eq < 0 ? pair : pair.slice(eq + 1)).trim();
            var expired = false;
            for (var i = 1; i < parts.length; i++) {
              var attr = parts[i].trim().toLowerCase();
              if (attr.indexOf('max-age=') === 0 && Number(attr.slice(8)) <= 0) expired = true;
              if (attr.indexOf('expires=') === 0) {
                var when = Date.parse(parts[i].trim().slice(8));
                if (!isNaN(when) && when < Date.now()) expired = true;
              }
            }
            if (expired) delete jar[name];
            else jar[name] = value;
          },
        });
      } catch (e) {
        // leave it
      }
    }
  }

  function tell(type, extra) {
    var message = { source: 'coursekit-package', type: type, item: boot.item };
    if (extra) for (var key in extra) message[key] = extra[key];
    var origin = boot.origin || '*';
    try {
      if (win.top && win.top !== win) win.top.postMessage(message, origin);
      else if (win.opener) win.opener.postMessage(message, origin);
    } catch (e) {
      // the page is gone
    }
  }

  if (boot.version !== '1.2' && boot.version !== '2004') return;

  var version = boot.version;
  var model = createModel(version, boot);
  var codes = CODES[version];
  var messages = MESSAGES[version];
  var state = 0; // 0 not initialized, 1 running, 2 terminated
  var lastError = '0';
  var diagnostic = '';
  var seq = 0;
  var sentChanges = 0;
  var dirty = false;
  /** The server refused a commit for good (the link is no longer valid): later Commit/Finish calls report it. */
  var refused = false;
  var startedAt = 0;

  /** Sends every element set in this session (the server ignores stale or repeated commits). */
  function send(terminate, beacon, after) {
    var done = after || function () {};
    if (!terminate && !dirty) return (done(), true);
    var changes = model.changes();
    dirty = false;
    seq++;
    var elapsed = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
    var body = JSON.stringify({ sid: boot.sid, seq: seq, ops: changes, terminate: !!terminate, elapsed: elapsed });
    sentChanges = changes.length;
    if (!boot.commitUrl) return (done(), true);
    try {
      if (beacon && win.navigator && win.navigator.sendBeacon && body.length < 60000) {
        if (win.navigator.sendBeacon(boot.commitUrl, body)) return (done(), true);
      }
      win
        .fetch(boot.commitUrl, {
          method: 'POST',
          body: body,
          keepalive: body.length < 60000,
          credentials: 'omit',
          headers: { 'Content-Type': 'text/plain' },
        })
        .then(
          function (res) {
            if (!res.ok) {
              dirty = true;
              if (res.status === 403) refused = true;
            }
            done();
          },
          function () {
            dirty = true;
            done();
          },
        );
    } catch (e) {
      dirty = true;
      return false;
    }
    return true;
  }

  function fail(kind, detail) {
    lastError = codes[kind] || kind;
    diagnostic = detail || '';
  }
  function ok() {
    lastError = '0';
    diagnostic = '';
  }
  function emptyArg(arg) {
    return arg === undefined || arg === null || arg === '';
  }

  function initialize(arg) {
    if (!emptyArg(arg)) return (fail('201', 'The argument must be an empty string.'), 'false');
    if (state === 1) return (fail(version === '1.2' ? '101' : '103', 'Already initialized.'), 'false');
    if (state === 2) return (fail(version === '1.2' ? '101' : '104', 'Already terminated.'), 'false');
    state = 1;
    startedAt = Date.now();
    ok();
    tell('initialize');
    return 'true';
  }
  function terminate(arg) {
    if (!emptyArg(arg)) return (fail('201', 'The argument must be an empty string.'), 'false');
    if (state === 0) return (fail(version === '1.2' ? '301' : '112', 'Not initialized.'), 'false');
    if (state === 2) return (fail(version === '1.2' ? '301' : '113', 'Already terminated.'), 'false');
    state = 2;
    var request = version === '2004' ? model.get('adl.nav.request').value : '_none_';
    send(true, false, function () {
      tell('terminate', { nav: request });
    });
    if (refused) return (fail(version === '1.2' ? '101' : '391', 'Progress is no longer being saved.'), 'false');
    ok();
    return 'true';
  }
  function getValue(element) {
    if (state !== 1) return (fail(version === '1.2' ? '301' : state === 0 ? '122' : '123'), '');
    var result = model.get(element);
    if (result.error) {
      fail(result.error, String(element));
      return '';
    }
    ok();
    return result.value;
  }
  function setValue(element, value) {
    if (state !== 1) return (fail(version === '1.2' ? '301' : state === 0 ? '132' : '133'), 'false');
    var error = model.set(element, value);
    if (error) {
      fail(error, String(element));
      return 'false';
    }
    dirty = true;
    ok();
    return 'true';
  }
  function commit(arg) {
    if (!emptyArg(arg)) return (fail('201', 'The argument must be an empty string.'), 'false');
    if (state !== 1) return (fail(version === '1.2' ? '301' : state === 0 ? '142' : '143'), 'false');
    if (
      refused ||
      !send(false, false, function () {
        tell('commit');
      })
    ) {
      return (fail(version === '1.2' ? '101' : '391'), 'false');
    }
    ok();
    return 'true';
  }
  function errorString(code) {
    return messages[String(code)] || '';
  }
  function getDiagnostic(code) {
    if (code === undefined || code === null || code === '' || String(code) === lastError) {
      return diagnostic ? errorString(lastError) + ': ' + diagnostic : errorString(lastError);
    }
    return errorString(code);
  }

  if (version === '1.2') {
    win.API = {
      LMSInitialize: initialize,
      LMSFinish: terminate,
      LMSGetValue: getValue,
      LMSSetValue: setValue,
      LMSCommit: commit,
      LMSGetLastError: function () {
        return lastError;
      },
      LMSGetErrorString: errorString,
      LMSGetDiagnostic: getDiagnostic,
    };
  } else {
    win.API_1484_11 = {
      version: '1.0',
      Initialize: initialize,
      Terminate: terminate,
      GetValue: getValue,
      SetValue: setValue,
      Commit: commit,
      GetLastError: function () {
        return lastError;
      },
      GetErrorString: errorString,
      GetDiagnostic: getDiagnostic,
    };
  }

  // When the page goes away without Finish/Terminate, end the session for the SCO. The API stays
  // usable: content that calls Finish from its own unload handler (which runs later) still gets through.
  function flush(end) {
    if (state !== 1) return;
    if (end) send(true, true);
    else if (dirty) send(false, true);
  }
  if (win.addEventListener) {
    win.addEventListener('pagehide', function () {
      flush(true);
    });
    if (doc && doc.addEventListener) {
      doc.addEventListener('visibilitychange', function () {
        if (doc.visibilityState === 'hidden') flush(false);
      });
    }
  }
  return {
    model: model,
    sent: function () {
      return sentChanges;
    },
  };
}
