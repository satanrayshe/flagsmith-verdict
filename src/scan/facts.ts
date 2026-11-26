export interface Loc { file: string; line: number; snippet: string }

export type SdkKind = 'browser' | 'react' | 'node';

export interface SdkInit extends Loc {
  kind: SdkKind;
  /** 'unknown' when the option is set from a variable or the options object is spread. */
  enableEvents: boolean | 'unknown';
  localEvaluation: boolean;
  hasIdentityOption: boolean;
  unstableIdentity: boolean;
}

export interface ExperimentFlagCall extends Loc { flag: string; api: 'getExperimentFlag' | 'useExperiment'; nodeFile: boolean }
export interface TrackEventCall extends Loc { name: string | null; hasIdentifier: boolean; nodeFile: boolean }
export interface ExposureCall extends Loc { flag: string | null; guarded: boolean }
export interface VariantCompare extends Loc { flag: string; literal: string; property: 'variant' | 'value' }
export interface IdentifyCall extends Loc { unstable: boolean }
export interface PackageDep { file: string; name: string; range: string }

export interface FileFacts {
  file: string;
  nodeFile: boolean;
  hasFlushOrClose: boolean;
  hasProcessExit: boolean;
  usesPersistence: boolean;
}

export interface Facts {
  root: string;
  filesScanned: number;
  parseErrors: { file: string; message: string }[];
  files: FileFacts[];
  inits: SdkInit[];
  experimentFlags: ExperimentFlagCall[];
  trackEvents: TrackEventCall[];
  exposures: ExposureCall[];
  compares: VariantCompare[];
  identifies: IdentifyCall[];
  deps: PackageDep[];
}

export function emptyFacts(root: string): Facts {
  return {
    root, filesScanned: 0, parseErrors: [], files: [], inits: [], experimentFlags: [], trackEvents: [],
    exposures: [], compares: [], identifies: [], deps: [],
  };
}
