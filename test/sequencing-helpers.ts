/** Hand-written SCORM 2004 manifests and a small driver for the sequencing engine. */
import { expect } from 'vitest';
import { parseScormManifest, type PackageStructure } from '../src/server/packages/manifest.js';
import { page, zip } from './package-helpers.js';
import { Sequencer, type NavOutcome, type RuntimeReport } from '../src/server/packages/sequencing/engine.js';
import { emptyState } from '../src/server/packages/sequencing/state.js';
import type { NavRequest, SequencingState, SequencingTree } from '../src/server/packages/sequencing/types.js';
import { navValidity, type NavValidity } from '../src/server/packages/sequencing/validity.js';

export const NS =
  'xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3" xmlns:imsss="http://www.imsglobal.org/xsd/imsss" xmlns:adlseq="http://www.adlnet.org/xsd/adlseq_v1p3" xmlns:adlnav="http://www.adlnet.org/xsd/adlnav_v1p3"';

/** A SCORM 2004 4th edition manifest. `items` and `seq` (the organization's sequencing) are raw XML. */
export function manifest(items: string, seq = '', extra = '') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="test" version="1" ${NS}>
  <metadata><schema>ADL SCORM</schema><schemaversion>2004 4th Edition</schemaversion></metadata>
  <organizations default="org"><organization identifier="org"><title>Course</title>
    ${items}
    ${seq ? `<imsss:sequencing>${seq}</imsss:sequencing>` : ''}
  </organization></organizations>
  <resources>
    <resource identifier="sco" type="webcontent" adlcp:scormType="sco" href="sco.html"><file href="sco.html"/></resource>
    <resource identifier="asset" type="webcontent" adlcp:scormType="asset" href="asset.html"><file href="asset.html"/></resource>
  </resources>
  ${extra}
</manifest>`;
}

/** A leaf item (a SCO unless `asset`), with optional sequencing XML and other item children. */
export const sco = (id: string, seq = '', more = '') =>
  `<item identifier="${id}" identifierref="sco"><title>${id}</title>${more}${seq ? `<imsss:sequencing>${seq}</imsss:sequencing>` : ''}</item>`;
export const asset = (id: string, seq = '') =>
  `<item identifier="${id}" identifierref="asset"><title>${id}</title>${seq ? `<imsss:sequencing>${seq}</imsss:sequencing>` : ''}</item>`;
export const cluster = (id: string, children: string, seq = '') =>
  `<item identifier="${id}"><title>${id}</title>${children}${seq ? `<imsss:sequencing>${seq}</imsss:sequencing>` : ''}</item>`;
export const control = (attrs: string) => `<imsss:controlMode ${attrs}/>`;
export const FLOW = control('choice="false" flow="true"');

export function structureOf(xml: string): PackageStructure {
  return parseScormManifest(xml, () => true);
}
export function treeOf(xml: string): SequencingTree {
  return structureOf(xml).sequencing!;
}

const report = (r: Partial<RuntimeReport>): RuntimeReport => ({
  completion: 'unknown',
  success: 'unknown',
  scaled: null,
  raw: null,
  min: null,
  max: null,
  progress: null,
  objectives: [],
  ...r,
});

/** Drives the engine like a learner: navigation requests and SCO reports, by item identifier. */
export class Learner {
  readonly state: SequencingState;
  now = Date.UTC(2026, 10, 25, 9);
  constructor(
    readonly tree: SequencingTree,
    seed = 7,
  ) {
    this.state = emptyState(tree, seed);
    this.seq().prepare();
  }
  seq(dryRun = false) {
    return new Sequencer(this.tree, this.state, this.now, dryRun);
  }
  index(id: string): number {
    const i = this.tree.activities.findIndex((a) => a.id === id);
    if (i < 0) throw new Error(`No activity ${id}`);
    return i;
  }
  id(i: number | null | undefined): string | null {
    return i === null || i === undefined ? null : this.tree.activities[i]!.id;
  }
  nav(request: NavRequest, target?: string): NavOutcome {
    return this.seq().navigate(request, target === undefined ? null : this.index(target));
  }
  /** Navigates and expects a delivery; returns the delivered identifier. */
  go(request: NavRequest, target?: string): string {
    const r = this.nav(request, target);
    expect(r, `${request} ${target ?? ''}`).toMatchObject({ valid: true });
    expect(r.delivered, `${request} ${target ?? ''} delivers something`).toBeDefined();
    return this.id(r.delivered)!;
  }
  get current(): string | null {
    return this.id(this.state.current);
  }
  /** The current SCO reports (cmi values), as a commit would. */
  report(r: Partial<RuntimeReport>, id = this.current!) {
    this.seq().applyRuntime(this.index(id), report(r));
  }
  /** Finishes the current SCO: completed and passed (or failed), with an optional score. */
  finish(success: 'passed' | 'failed' | 'unknown' = 'passed', scaled: number | null = null, objectives: RuntimeReport['objectives'] = []) {
    this.report({ completion: 'completed', success, scaled, objectives });
  }
  validity(): NavValidity {
    return navValidity(this.tree, this.state, this.now);
  }
  choosable(): string[] {
    return [...this.validity().choice].map((i) => this.id(i)!).filter((id) => id !== 'org');
  }
  activity(id: string) {
    return this.state.activities[this.index(id)]!;
  }
  status(id: string) {
    const s = this.seq();
    const i = this.index(id);
    return { completed: s.completed(i, false), satisfied: s.satisfied(i, 0, false), measure: s.measure(i, 0, false) };
  }
}

/** A zip for a hand-written manifest: every item uses sco.html or asset.html. */
export function sequencedZip(xml: string): Uint8Array {
  return zip({ 'imsmanifest.xml': xml, 'sco.html': page('SCO'), 'asset.html': page('Asset') });
}

export const objectiveReport = (id: string, success: 'passed' | 'failed' | 'unknown', scaled: number | null = null) => ({
  id,
  success,
  completion: 'unknown' as const,
  scaled,
  raw: null,
  min: null,
  max: null,
  progress: null,
});
