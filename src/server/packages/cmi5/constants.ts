/** IRIs, document names and limits of the cmi5 specification (Quartz edition) as Coursekit uses them. */

export const CMI5_NAMESPACE = 'https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd';

const ADL = 'http://adlnet.gov/expapi/verbs/';
const W3ID = 'https://w3id.org/xapi/adl/verbs/';

export const VERBS = {
  launched: `${ADL}launched`,
  initialized: `${ADL}initialized`,
  completed: `${ADL}completed`,
  passed: `${ADL}passed`,
  failed: `${ADL}failed`,
  terminated: `${ADL}terminated`,
  abandoned: `${W3ID}abandoned`,
  waived: `${W3ID}waived`,
  satisfied: `${W3ID}satisfied`,
  voided: `${ADL}voided`,
} as const;

/** Verbs only the LMS may use in cmi5 defined statements. */
export const LMS_VERBS: readonly string[] = [VERBS.launched, VERBS.abandoned, VERBS.waived, VERBS.satisfied];

export const CATEGORY_CMI5 = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';
export const CATEGORY_MOVE_ON = 'https://w3id.org/xapi/cmi5/context/categories/moveon';

export const EXT_SESSION_ID = 'https://w3id.org/xapi/cmi5/context/extensions/sessionid';
export const EXT_MASTERY_SCORE = 'https://w3id.org/xapi/cmi5/context/extensions/masteryscore';
export const EXT_LAUNCH_MODE = 'https://w3id.org/xapi/cmi5/context/extensions/launchmode';
export const EXT_LAUNCH_URL = 'https://w3id.org/xapi/cmi5/context/extensions/launchurl';
export const EXT_MOVE_ON = 'https://w3id.org/xapi/cmi5/context/extensions/moveon';
export const EXT_LAUNCH_PARAMETERS = 'https://w3id.org/xapi/cmi5/context/extensions/launchparameters';

export const ACTIVITY_TYPE_BLOCK = 'https://w3id.org/xapi/cmi5/activitytype/block';
export const ACTIVITY_TYPE_COURSE = 'https://w3id.org/xapi/cmi5/activitytype/course';

/** The State API document Coursekit writes before every launch. */
export const LAUNCH_DATA = 'LMS.LaunchData';
/** The Agent Profile document with the learner's preferences. */
export const LEARNER_PREFERENCES = 'cmi5LearnerPreferences';

/** Query string names the LMS adds to every AU launch URL; an AU URL may not use them itself. */
export const LAUNCH_PARAMETER_NAMES = ['endpoint', 'fetch', 'actor', 'registration', 'activityId'];

/** How long the one-time fetch URL of a launch can be used. */
export const FETCH_MINUTES = 30;
/** A session without any request for this long is abandoned. */
export const SESSION_TIMEOUT_HOURS = 12;
/** Longest a session's credentials can live, however busy the session is. */
export const CREDENTIAL_DAYS = 7;
/** After "terminated", the AU's credentials can still read and save documents for this long (no statements). */
export const TERMINATED_GRACE_SECONDS = 60;
/** Most AUs and blocks a course structure may have (the specification asks for more than 1000 AUs). */
export const MAX_NODES = 5000;
export const MAX_DEPTH = 50;
/** Longest AU <url>: every launch copies it into the session and the "launched" statement. */
export const MAX_URL_LENGTH = 2048;
/** Most <langstring> elements in one title or description. */
export const MAX_LANGSTRINGS = 50;
/** Most launches (sessions) of one registration: each adds a session and Coursekit's own statements. */
export const MAX_SESSIONS_PER_ATTEMPT = 2000;
/** Largest statement Coursekit stores itself, the same limit as for the statements AUs send (xapi.ts). */
export const MAX_LMS_STATEMENT_BYTES = 32 * 1024;
/** The cmi5LearnerPreferences languagePreference when the learner's browser sends no usable Accept-Language. */
export const DEFAULT_LANGUAGE = 'en-US';
