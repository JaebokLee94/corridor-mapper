# Comparison protocol and evidence provenance

**Original threshold source: `tuning-200-20261020`. Reference PSPT revision: `guarded45-shared-pose-bounded-clusters-20261104`.**

This document distinguishes threshold selection, historical evaluation and the current interactive experiment. The live straight-route profiles are in [`drf/echo-comparison.mjs`](drf/echo-comparison.mjs). Other fleet profiles and the score rule are in [`drf/comparison.mjs`](drf/comparison.mjs). The [machine-readable tuning record](validation/threshold-tuning-20261020.json) contains the selected source aggregates, generator settings, condition counts and SHA-256 hashes of the original analysis/plan files. The full external raw tuning archive is not included.

## Operating points

| Method | Current fixed log-score threshold | Previous development threshold | Score used for selection |
|:--|--:|--:|:--|
| WM-P, straight upper wall, 3 vehicles | 6.0 | 10.754131418601359 | Current four-hypothesis marginal log-odds |
| WM-P, straight upper wall, 10 vehicles | 6.5 | 4.5 | Same score |
| WM-P, other scenes, 3 vehicles | 10.754131418601359 | 6.650397183049193 | Current four-hypothesis marginal log-odds |
| WM-P, other scenes, 10 vehicles | 4.5 | 6.650397183049193 | Same score |
| WM-P, other fleet sizes | 6.650397183049193 | 6.4615384615384635 | Current marginal log-odds of original/both versus neither/mirror, or the symmetric alternative |
| WM-F, 3 vehicles | 28 | 29.108623616301394 | Same qualified score, with 2 m fragments and two matching snapshots |
| WM-F, other fleet sizes | 29.108623616301394 | 12 | Maximum qualified Gaussian log-score observed up to the current snapshot |

The November 14 straight-route search maximized mean final Map F1 for the supported patches at a 0.4 m tolerance with interpolation off. Each fleet used 16 fit configurations on 16 development seeds, then compared the three best configurations and the incumbent on 96 new seeds. The 116 candidate score thresholds included both incumbents. Each stage balanced wall roughness height SDs of 0.33 and 3 m. All scenes used 100 snapshots, position SD 0 m, range SD 0.4 m, a single upper wall and specular returns. The same frozen setting applies throughout every run of that fleet on the straight route.

- Three vehicles use the last eight snapshots for candidate refinement (`K=8`) and tangent search extent factor `ext=1.1`. Initial tangent half-length stays 4 m, missed-return probability 0.05 and maximum range 45 m.
- Ten vehicles use a relative ridge cutoff of 0.08, minimum ridge separation 1 m and candidate duplicate radius 0.7 m. Initial tangent half-length stays 1.25 m, missed-return probability 0.25 and maximum range 45 m.

On 512 separate evaluation seeds per fleet (256 per roughness height), the two profiles gave the following final raw map results. Both profiles received the same measurements in every pair. One initial seed exhausted the generator’s 256 attempts before it produced a wall; a replacement from the same 3 m stratum was selected without using either estimator’s output.

| Vehicles | Previous mean F1 | Tuned mean F1 | Difference (95% interval), percentage points | Mean off-wall fragment length, previous → tuned |
|---:|---:|---:|---:|---:|
| 3 | 62.78% | 63.48% | +0.70 (+0.22 to +1.19) | 78.8 → 124.6 m |
| 10 | 72.37% | 77.34% | +4.97 (+4.59 to +5.36) | 41.8 → 57.1 m |

Intervals use 4,000 paired bootstrap resamples within roughness strata. Off-wall length counts each supported fragment, including overlapping fragments. The selection objective was F1 and did not penalize runtime: on a Mac, median time for 100 WM-P tracking steps (8 tuning seeds; no scene generation, evaluation or rendering) changed from 0.63 to 0.55 s for 3 vehicles and from 3.06 to 14.38 s for 10.

The November 12 WM-P selection used 40 screening scenes and 60 separate tuning scenes to maximize mean final raw Map F1 at 0.4 m. Three vehicles use tangent half-length 4 m, missed-return model probability 0.05 and candidate range 45 m. Ten vehicles use 1.25 m, 0.25 and 45 m respectively. The independent test used 100 separate scenes. The selection objective did not constrain off-wall length or test openings and branches.

For three vehicles, WM-F uses a fleet-specific threshold selected on opening and fork scenes using final extended centre spline Map F1, with limits on full opening closures and wrong-branch connections. Selection and confirmation used separate seeds. The full fragment length is 2 m for all vehicle counts.

The previous B value of 12 was the upper endpoint of a 40-point grid over [−12, 12]. The original 200-scene tuning explored all finite eligible score breakpoints. A fragment or patch is supported when its qualified score is **at least** its method's threshold. The protocol fixes the threshold before the run; the displayed wall and evaluation metrics do not adjust it.

PSPT also requires its geometry and own-patch evidence guards. B's score is eligible after at least two matched snapshots; a fragment is scored over 20 subsequent snapshots, and regeneration uses a 5-snapshot cooldown. B retains a past qualified crossing even after expiry, while PSPT uses its current hypothesis weights. Their numerical scores and computational budgets are not interchangeable.

The historical `Baseline.report()` default remains 12 solely to reproduce frozen Python checkpoints. Every current comparison and sweep passes the current threshold explicitly. The native PSPT's historical 0.99 gate is also retained internally for reference parity; current support selection is applied by the comparison wrapper, with the exact log-score threshold above.

## PSPT revision on 2026-11-04

The live comparison and sweep now account for shared vehicle position error during initial candidate refinement. Pairs that share a vehicle have correlated range prediction errors; treating these pairs as independent understated candidate uncertainty. A pose-space Woodbury solve includes those correlations without forming one dense matrix across the creation window.

Echo grouping also changes from single-link clustering to a bounded-diameter rule. A chain of individually close returns could previously combine widely separated ranges, including returns from different walls, into one overconfident mean. Each new cluster's maximum-minus-minimum range is limited by the existing noise-based gate. This is a grouping-model revision, not a guarantee that every cluster represents one physical reflector. The shared range simulator, truth-side evaluator and Fixed-fragment B are unchanged.

The frozen `new PSPT()` reference retains `independent-pairs` refinement and `single-link` clustering. `MethodComparison` explicitly selects `shared-pose` and `bounded-span`. The November 4 revision inherited the October threshold. The November 12 fleet-specific settings are listed above. No displayed truth enters either estimator or selects its threshold.

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
| Current unshared defaults | Interactive upper-wall straight route | 3 on localhost; 10 on shared site | 0 m | 0.4 m | 100 | Specular only, 0.6 m range resolution; new random seed on unseeded load |
| README / shared example | One illustrative scene | 10 | 0.1 m | 0.1 m | 120 | Seed 549028359; not an aggregate benchmark |
| Parameter sweep | Paired conditions chosen by the user | Current setting | Current setting | Swept | Current setting | Same methods, gates and metrics as the main view |

Since the independent-wall update on 2026-10-22, the current layered **Both walls** generator draws separate large-scale B-splines for the lower and upper walls. It enforces a minimum 6 m vertical gap through constant symmetric translations, using exact piecewise-cubic extrema. The route is then derived from their midpoint, retaining its full ±2 m lateral oscillation. The minimum gap is twice the sum of that 2 m amplitude and 1 m vertical truth-pose clearance: 6 m. This bounds every vehicle phase, including between snapshots; it is not a vehicle-body or Euclidean-clearance model. Domain rejection remains truth-side and independent of the requested fleet, duration, and measured noise. The exported wall-model kind is `independent-wall-uniform-cubic`; single-wall and archived shared-centre models retain `two-layer-uniform-cubic`. Old shared settings URLs use the current generator, so reproducing earlier walls also requires the earlier commit.

The archived October trajectories advanced 0.75 m per snapshot. The current layered trajectory advances ⅔ m per snapshot; legacy `reference` / `random` trajectories retain 0.75 m for historical fixtures. Consequently, even matching vehicle/noise settings does not recreate the old distribution or full observation sequence. Display-grid resolution is independent of the fixed 100 × 100 candidate grids.

## What the tuning result means

The October 2026 selection objective was maximum observed-wall recall subject to **empirical mean grouped-fragment false-positive loss ≤ 0.01**. The original targets were FP ≤ 1%, recall ≥ 60%, and confidence parameter δ = 0.1. The tuning exercise did not run a new calibration or test stage.

| Archived tuning statistic | Guarded PSPT | Fixed-fragment B |
|:--|--:|--:|
| Mean grouped-fragment FP | 0.009922129544332789 | 0.007916666666666666 |
| Mean observed-wall recall | 0.5870240280203328 | 0.025677596277877145 |
| Centre precision, nonempty scenes only | 0.9925048752570995 | 1.0 |
| Empty-scene fraction | 0 | 0.435 |
| Operating points meeting both FP and recall targets | 0 | 0 |

These are equal-scene means. The tuning grouped-fragment loss treats an empty estimate as zero FP; centre precision excludes empty scenes. This makes the empty-scene fraction essential to interpreting B's result. Grouped-fragment FP is not the browser's fraction of off-wall centres, and 1.0 nonempty centre precision does not imply complete or error-free wall reconstruction.

Neither method obtained an LTT-certified threshold in the earlier calibration study. Applying a fixed development threshold to a new scene does not introduce online truth leakage, but the scene's displayed metrics do not establish generalisation or a certified error rate. The November 14 independent test covers only the straight-route upper-wall simulation at 3 and 10 vehicles. It does not validate the layered generator or establish a false-positive guarantee.

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

The current interactive Run and sweep use `EchoComparison` and `createPSPTEvaluator`. Each sweep job generates one scene and replays identical measured snapshots through both methods. It inherits the current duration and other settings, changing only range SD, roughness and seed. Aggregation separates methods, full non-seed inputs and method protocols, so different durations or thresholds are not silently pooled.

JSON schema **`echomap-drf/5`** includes full estimator threshold and revision metadata, measured prefixes, per-method candidate decisions, post-hoc evaluation, and separately labelled truth. Sweep records include both method summaries and their protocol. CSV adds `selection_threshold`, `threshold_source` and `implementation_revision` to each method/snapshot row. Reconnected runs retain their recorded protocol; packets from the earlier unversioned server are labelled as legacy. Physical duration per snapshot remains unspecified.

The old `evaluate.mjs` outer-peak extractor uses a y = 15 wall split and an x ∈ [10, 50] column window. Those assumptions are unsuitable for general layered scenes. It is now labelled **legacy only**, excluded from the Pages package and live runtime, and retained solely for historical tests. Current exports do not contain its `offset`, `observedColumns`, `caMsd` or `caHd95` fields. Scattering counts and local-theorem diagnostics use a separate reflection-only module with explicit generator wall identities.

## Simulation scope

The reported pose/range noise levels match those used by the generator. This is a nominal declared-noise setup, not a claim that every estimator assumption exactly matches curved geometry and scattering. Controlled mismatch settings, independent calibration after tuning, and physical-sensor validation remain future experiments. No mismatch-robustness or real-environment claim is made by this release.
