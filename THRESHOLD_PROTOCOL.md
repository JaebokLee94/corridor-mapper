# Comparison protocol and evidence provenance

**Threshold source: `tuning-200-20261020`. Current PSPT revision: `guarded45-shared-pose-bounded-clusters-20261104`.**

This document distinguishes threshold selection, historical evaluation and the current interactive experiment. The executable source of truth is [`drf/comparison.mjs`](drf/comparison.mjs). The [machine-readable tuning record](validation/threshold-tuning-20261020.json) contains the selected source aggregates, generator settings, condition counts and SHA-256 hashes of the original analysis/plan files. The full external raw tuning archive is not included.

## Operating points

| Method | Current fixed log-score threshold | Previous development threshold | Score used for selection |
|:--|--:|--:|:--|
| Guarded PSPT | 6.650397183049193 | 6.4615384615384635 | Current marginal log-odds of original/both versus neither/mirror, or the symmetric alternative |
| Fixed-fragment B | 29.108623616301394 | 12 | Maximum qualified Gaussian log-score observed up to the current snapshot |

The previous B value was the upper endpoint of a 40-point grid over [−12, 12]. The newer tuning explored all finite eligible score breakpoints. A fragment or patch is supported when its qualified score is **at least** its method's threshold. There is no scene-specific adjustment and no evaluator feedback into the estimator.

PSPT also requires its geometry and own-patch evidence guards. B's score is eligible after at least two matched snapshots; a fragment is scored over 20 subsequent snapshots, and regeneration uses a 5-snapshot cooldown. B retains a past qualified crossing even after expiry, while PSPT uses its current hypothesis weights. Their numerical scores and computational budgets are not interchangeable.

The historical `Baseline.report()` default remains 12 solely to reproduce frozen Python checkpoints. Every current comparison and sweep passes the current threshold explicitly. The native PSPT's historical 0.99 gate is also retained internally for reference parity; current support selection is applied by the comparison wrapper, with the exact log-score threshold above.

## PSPT revision on 2026-11-04

The live comparison and sweep now account for shared vehicle position error during initial candidate refinement. Pairs that share a vehicle have correlated range prediction errors; treating these pairs as independent understated candidate uncertainty. A pose-space Woodbury solve includes those correlations without forming one dense matrix across the creation window.

Echo grouping also changes from single-link clustering to a bounded-diameter rule. A chain of individually close returns could previously combine widely separated ranges, including returns from different walls, into one overconfident mean. Each new cluster's maximum-minus-minimum range is limited by the existing noise-based gate. This is a grouping-model revision, not a guarantee that every cluster represents one physical reflector. The shared range simulator, truth-side evaluator and Fixed-fragment B are unchanged.

The frozen `new PSPT()` reference retains `independent-pairs` refinement and `single-link` clustering. `MethodComparison` explicitly selects `shared-pose` and `bounded-span`. **The threshold above is inherited, not retuned or certified for this revision.** No displayed truth enters either estimator or selects its threshold.

The reported seed and three additional diagnostic seeds use identical settings within each before/after pair. [Inputs, wire hashes and scalar results](validation/pspt-repair-20261104.json) are recorded separately.

| Seed | Observed recall, before → after | Surface F1, before → after |
|:--|--:|--:|
| 3143081491, reported case | 61.74% → 74.55% | 76.00% → 84.86% |
| 1 | 71.85% → 73.82% | 83.59% → 84.77% |
| 42 | 89.05% → 92.14% | 94.20% → 95.91% |
| 874230748 | 71.97% → 77.63% | 83.70% → 87.00% |

Centre precision remains 100% in these four cases. Across the three additional seeds, mean surface precision falls from 99.97% to 99.50%; seed 874230748's centre-error P95 rises from 0.0549 m to 0.1287 m. These are diagnostic observations, not a claim of uniform error reduction or generalisation. The geometric distance metrics do not certify correct tangents or curvature.

## Dataset roles and distribution

| Dataset / view | Role | Vehicles | Position SD | Range SD | Snapshots | Notes |
|:--|:--|--:|--:|--:|--:|:--|
| Original 54 cases, seeds 501–506 | Originally evaluation; subsequently reused for development | 3 | 0.1 m | 0.1 m | 120 | Nine wall/scattering configurations per seed; not independent evidence for current selection |
| Tuning 200, seeds 12000000–12000199 | Exploratory threshold selection | 3 | 0 m | 0.1 m | 120 | Distinct tuning seed block; mixed wall/scattering conditions; no certification |
| Current unshared defaults | Interactive nominal simulation | 10 | 0.1 m | 0.1 m | 120 | Both walls, mixed returns, roughness 2°; new random seed on unseeded load |
| README / shared example | One illustrative scene | 10 | 0.1 m | 0.1 m | 120 | Seed 549028359; not an aggregate benchmark |
| Parameter sweep | Paired conditions chosen by the user | Current setting | Current setting | Swept | Current setting | Same methods, gates and metrics as the main view |

Since the independent-wall update on 2026-10-22, the current layered **Both walls** generator draws separate large-scale B-splines for the lower and upper walls. It enforces a minimum 6 m vertical gap through constant symmetric translations, using exact piecewise-cubic extrema. The route is then derived from their midpoint, retaining its full ±2 m lateral oscillation. The minimum gap is twice the sum of that 2 m amplitude and 1 m vertical truth-pose clearance: 6 m. This bounds every vehicle phase, including between snapshots; it is not a vehicle-body or Euclidean-clearance model. Domain rejection remains truth-side and independent of the requested fleet, duration, and measured noise. The exported wall-model kind is `independent-wall-uniform-cubic`; single-wall and archived shared-centre models retain `two-layer-uniform-cubic`. Old shared settings URLs use the current generator, so reproducing earlier walls also requires the earlier commit.

The historical and tuning trajectories advanced 0.75 m per snapshot. The current layered trajectory advances ⅔ m per snapshot; legacy `reference` / `random` trajectories retain 0.75 m for historical fixtures. Consequently, even matching vehicle/noise settings does not recreate the old distribution or full observation sequence. Display-grid resolution is independent of the fixed 100 × 100 candidate grids.

## What the tuning result means

The selection objective was maximum observed-wall recall subject to **empirical mean grouped-fragment false-positive loss ≤ 0.01**. The original targets were FP ≤ 1%, recall ≥ 60%, and confidence parameter δ = 0.1. The tuning exercise did not run a new calibration or test stage.

| Archived tuning statistic | Guarded PSPT | Fixed-fragment B |
|:--|--:|--:|
| Mean grouped-fragment FP | 0.009922129544332789 | 0.007916666666666666 |
| Mean observed-wall recall | 0.5870240280203328 | 0.025677596277877145 |
| Centre precision, nonempty scenes only | 0.9925048752570995 | 1.0 |
| Empty-scene fraction | 0 | 0.435 |
| Operating points meeting both FP and recall targets | 0 | 0 |

These are equal-scene means. The tuning grouped-fragment loss treats an empty estimate as zero FP; centre precision excludes empty scenes. This makes the empty-scene fraction essential to interpreting B's result. Grouped-fragment FP is not the browser's fraction of off-wall centres, and 1.0 nonempty centre precision does not imply complete or error-free wall reconstruction.

Neither method obtained an LTT-certified threshold in the earlier calibration study. Applying a fixed development threshold to a new scene does not introduce online truth leakage, but the scene's displayed metrics do not establish generalisation or a certified error rate. The current release has not undergone a fresh independent population study after its trajectory and independent-wall generator changes.

## Current post-hoc metrics

The evaluator uses current candidate geometry and truth from the measured prefix only. It samples true cubic wall spans and supported patches approximately uniformly in arc length at spacing ≤ 0.05 m, with a **0.4 m** distance tolerance. A true wall sample becomes observed when it is within **1 m** of a generated reflection point at or before the selected snapshot.

- Centre precision: supported centres within tolerance / supported centres.
- Observed recall: observed wall samples within tolerance of supported patches / observed wall samples.
- Surface precision: sampled supported-patch points within tolerance / sampled supported-patch points. Overlap counts repeatedly.
- Surface F₁: harmonic mean of surface precision and observed recall.
- P95: nearest-rank 95th percentile of supported-centre distances to sampled truth.
- Off-wall fraction: one minus centre precision.
- First-support precision: centre precision when each unique candidate was first supported. Later movement or rejection does not revise that event.

An empty estimate has undefined precision/P95; its recall is zero if some wall has been observed. If no wall is observed, recall is undefined. JSON uses `null`, CSV leaves missing numeric values blank, and the UI shows a dash. Sweeps average defined values and report valid/failed/missing counts; sample SD requires at least two defined seed values and is not a confidence interval.

## Main comparison, sweep and exports

Both views use `MethodComparison` and `createPSPTEvaluator`. Each sweep job generates one scene and replays identical measured snapshots through both methods. It inherits the current duration and other settings, changing only range SD, roughness and seed. Aggregation separates methods, full non-seed inputs and method protocols, so different durations or thresholds are not silently pooled.

JSON schema **`echomap-drf/5`** includes full estimator threshold and revision metadata, measured prefixes, per-method candidate decisions, post-hoc evaluation, and separately labelled truth. Sweep records include both method summaries and their protocol. CSV adds `selection_threshold`, `threshold_source` and `implementation_revision` to each method/snapshot row. Reconnected runs retain their recorded protocol; packets from the earlier unversioned server are labelled as legacy. Physical duration per snapshot remains unspecified.

The old `evaluate.mjs` outer-peak extractor uses a y = 15 wall split and an x ∈ [10, 50] column window. Those assumptions are unsuitable for general layered scenes. It is now labelled **legacy only**, excluded from the Pages package and live runtime, and retained solely for historical tests. Current exports do not contain its `offset`, `observedColumns`, `caMsd` or `caHd95` fields. Scattering counts and local-theorem diagnostics use a separate reflection-only module with explicit generator wall identities.

## Simulation scope

The reported pose/range noise levels match those used by the generator. This is a nominal declared-noise setup, not a claim that every estimator assumption exactly matches curved geometry and scattering. Controlled mismatch settings, independent calibration after tuning, and physical-sensor validation remain future experiments. No mismatch-robustness or real-environment claim is made by this release.
