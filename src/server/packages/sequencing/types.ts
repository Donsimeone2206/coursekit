/**
 * The SCORM 2004 Sequencing Definition Model (what the manifest says about each activity) and the
 * tracking model (what happened in one learner's attempt), as the Sequencing and Navigation (SN)
 * book of SCORM 2004 4th Edition defines them. Both are plain JSON: the definitions are stored with
 * the package version, the tracking state with each Coursekit attempt.
 */

export type RuleCondition =
  | 'satisfied'
  | 'objectiveStatusKnown'
  | 'objectiveMeasureKnown'
  | 'objectiveMeasureGreaterThan'
  | 'objectiveMeasureLessThan'
  | 'completed'
  | 'activityProgressKnown'
  | 'attempted'
  | 'attemptLimitExceeded'
  | 'timeLimitExceeded'
  | 'outsideAvailableTimeRange'
  | 'always';

export type PreAction = 'skip' | 'disabled' | 'hiddenFromChoice' | 'stopForwardTraversal';
export type ExitAction = 'exit';
export type PostAction = 'exitParent' | 'exitAll' | 'retry' | 'retryAll' | 'continue' | 'previous';
export type RuleAction = PreAction | ExitAction | PostAction;

export interface RuleConditionDef {
  condition: RuleCondition;
  not: boolean;
  /** An objective id of the activity; null uses the activity's primary objective. */
  objective: string | null;
  threshold: number;
}

export interface SequencingRule {
  combination: 'all' | 'any';
  conditions: RuleConditionDef[];
  action: RuleAction;
}

export type RollupAction = 'satisfied' | 'notSatisfied' | 'completed' | 'incomplete';
export type ChildActivitySet = 'all' | 'any' | 'none' | 'atLeastCount' | 'atLeastPercent';

export interface RollupRule {
  childActivitySet: ChildActivitySet;
  minimumCount: number;
  minimumPercent: number;
  combination: 'all' | 'any';
  conditions: Array<{ condition: RuleCondition; not: boolean }>;
  action: RollupAction;
}

/** imsss:mapInfo and adlseq:mapInfo for one shared (global) objective. */
export interface ObjectiveMap {
  target: string;
  readSatisfied: boolean;
  readMeasure: boolean;
  writeSatisfied: boolean;
  writeMeasure: boolean;
  readRaw: boolean;
  readMin: boolean;
  readMax: boolean;
  readCompletion: boolean;
  readProgress: boolean;
  writeRaw: boolean;
  writeMin: boolean;
  writeMax: boolean;
  writeCompletion: boolean;
  writeProgress: boolean;
}

export interface ObjectiveDef {
  /** objectiveID; the primary objective may have none. */
  id: string | null;
  /** The primary objective contributes to rollup. It is always objectives[0]. */
  primary: boolean;
  satisfiedByMeasure: boolean;
  minNormalizedMeasure: number;
  maps: ObjectiveMap[];
}

export type RequiredFor = 'always' | 'ifAttempted' | 'ifNotSkipped' | 'ifNotSuspended';
export type Timing = 'never' | 'once' | 'onEachNewAttempt';
export type LmsControl = 'previous' | 'continue' | 'exit' | 'exitAll' | 'abandon' | 'abandonAll' | 'suspendAll';

export interface ActivityDef {
  /** Item identifier (the organization's for the root). */
  id: string;
  title: string;
  /** Index of the parent; -1 for the root. */
  parent: number;
  /** Child indexes in manifest order. */
  children: number[];
  /** 0 for the organization's items; -1 for the root. */
  depth: number;
  /** Has content to launch (leaves only). */
  launchable: boolean;
  /** A SCO (talks to the run-time) rather than an asset. */
  sco: boolean;
  /** item@isvisible: shown in the table of contents. */
  visible: boolean;
  // Control modes
  choice: boolean;
  choiceExit: boolean;
  flow: boolean;
  forwardOnly: boolean;
  useCurrentAttemptObjectiveInfo: boolean;
  useCurrentAttemptProgressInfo: boolean;
  // Sequencing rules
  preRules: SequencingRule[];
  exitRules: SequencingRule[];
  postRules: SequencingRule[];
  // Limit conditions (null: no limit)
  attemptLimit: number | null;
  /** Seconds. */
  attemptDurationLimit: number | null;
  // Rollup
  rollupRules: RollupRule[];
  rollupObjectiveSatisfied: boolean;
  rollupProgressCompletion: boolean;
  objectiveMeasureWeight: number;
  // Objectives (objectives[0] is the primary objective)
  objectives: ObjectiveDef[];
  // Selection and randomization
  selectionTiming: Timing;
  /** null: no selection count. */
  selectCount: number | null;
  randomizationTiming: Timing;
  reorderChildren: boolean;
  // Delivery controls
  tracked: boolean;
  completionSetByContent: boolean;
  objectiveSetByContent: boolean;
  // ADL extensions
  preventActivation: boolean;
  constrainChoice: boolean;
  requiredForSatisfied: RequiredFor;
  requiredForNotSatisfied: RequiredFor;
  requiredForCompleted: RequiredFor;
  requiredForIncomplete: RequiredFor;
  measureSatisfactionIfActive: boolean;
  completedByMeasure: boolean;
  minProgressMeasure: number;
  progressWeight: number;
  hideLmsUi: LmsControl[];
  /** adlcp:data maps (4th edition shared data). */
  dataMaps: Array<{ target: string; read: boolean; write: boolean }>;
}

export interface SequencingTree {
  /** activities[0] is the root (the organization), the rest are the items in manifest (preorder) order. */
  activities: ActivityDef[];
  objectivesGlobalToSystem: boolean;
  sharedDataGlobalToSystem: boolean;
}

// ----- tracking model -----

/** Objective progress information (local objectives and shared global objectives). Absent fields are false/unknown. */
export interface ObjectiveState {
  /** Objective Progress Status (the satisfied status is known). */
  ps?: boolean;
  /** Objective Satisfied Status. */
  ss?: boolean;
  /** Objective Measure Status. */
  ms?: boolean;
  /** Objective Normalized Measure (-1..1). */
  nm?: number;
  raw?: number;
  min?: number;
  max?: number;
  /** Completion status known (4th edition objective completion). */
  cps?: boolean;
  /** Completed. */
  cs?: boolean;
  /** Progress measure known. */
  pms?: boolean;
  /** Progress measure (0..1). */
  pm?: number;
}

export interface ActivityState {
  /** Activity is Active. */
  active?: boolean;
  /** Activity is Suspended. */
  suspended?: boolean;
  /** Activity Progress Status (attempted at least once). */
  aps?: boolean;
  /** Activity Attempt Count. */
  count?: number;
  /** Attempt Progress Status (the completion status is known). */
  ps?: boolean;
  /** Attempt Completion Status. */
  cs?: boolean;
  /** Attempt Completion Amount Status. */
  cas?: boolean;
  /** Attempt Completion Amount (0..1). */
  ca?: number;
  /** When the current (or last) attempt began and ended, ms since the epoch. */
  start?: number;
  end?: number;
  /** Clock value when the current attempt began, for useCurrentAttemptObjectiveInfo/ProgressInfo. */
  stamp?: number;
  /** Local objectives, aligned with ActivityDef.objectives. */
  objectives?: ObjectiveState[];
  /** Available Children (after selection and randomization); absent means every child in order. */
  available?: number[];
  /** Delivery number of the latest delivery of this activity. */
  delivery?: number;
  /** The latest delivery resumed a suspended attempt. */
  resumed?: boolean;
  /** Coursekit: seconds of SCO session time recorded before the current attempt began (cmi.total_time is per attempt). */
  base?: number;
}

export interface SequencingState {
  v: 1;
  /** Current Activity (index), null when no sequencing session is running. */
  current: number | null;
  /** Suspended Activity (index). */
  suspended: number | null;
  activities: ActivityState[];
  /** Shared global objectives, scoped to this attempt. */
  globals: Record<string, ObjectiveState>;
  /** Shared data stores (adl.data), scoped to this attempt. */
  data: Record<string, string>;
  /** Monotonic counter for attempt stamps. */
  clock: number;
  /** Counts deliveries; each delivery gets the next number. */
  deliveries: number;
  /** PRNG state for selection and randomization. */
  rng: number;
  /** The sequencing session ended without suspending: the attempt is over. */
  ended?: boolean;
}

export type NavRequest =
  'start' | 'resumeAll' | 'continue' | 'previous' | 'choice' | 'jump' | 'exit' | 'exitAll' | 'abandon' | 'abandonAll' | 'suspendAll';

export const ROOT = 0;
