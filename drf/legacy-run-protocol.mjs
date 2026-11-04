// Worker packets emitted before run-level provenance was added have no protocol.
// These historical values must stay independent of the current method defaults.
const tuning = Object.freeze({
  id:'tuning-200-20261020', role:'development / exploratory tuning', scenes:200,
  seedRangeInclusive:Object.freeze([12000000,12000199]), vehicles:3, snapshots:120, sigmaP:0, sigmaD:0.1,
  selection:'maximum observed-wall recall among score breakpoints with mean grouped-fragment FP <= 0.01',
  certified:false, jointFpRecallTargetMet:false, source:'validation/threshold-tuning-20261020.json',
});
export const LEGACY_RUN_PROTOCOL = Object.freeze({
  guarded:Object.freeze({name:'Guarded PSPT',threshold:6.650397183049193,previousDevThreshold:6.4615384615384635,
    score:'current four-hypothesis marginal log-odds',grid:Object.freeze([100,100]),calibrated:false,tuning,
    revision:'guarded45-independent-pairs-single-link-legacy',refinement:'independent-pairs',clustering:'single-link',
    protocolSource:'Legacy fallback: the prepared packet did not include run protocol metadata.'}),
  baseline:Object.freeze({name:'Fixed-fragment B',threshold:29.108623616301394,previousDevThreshold:12,
    score:'maximum qualified Gaussian log-score through the current snapshot',grid:Object.freeze([100,100]),calibrated:false,tuning,
    revision:'fixed-fragment-b-legacy-unversioned',
    protocolSource:'Legacy fallback: the prepared packet did not include run protocol metadata.'}),
});
