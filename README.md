<div align="center">

# EchoMap

### Range-only wall mapping from collaborative bistatic echoes

A research workbench for seeing how measurements become surface hypotheses, and when those hypotheses remain ambiguous.

[![Tests and deployment](https://github.com/JaebokLee94/corridor-mapper/actions/workflows/pages.yml/badge.svg)](https://github.com/JaebokLee94/corridor-mapper/actions/workflows/pages.yml)
[![Live workbench](https://img.shields.io/badge/Live_workbench-Open-1e6386?style=flat-square)](https://jaeboklee94.github.io/corridor-mapper/drf.html)
[![License](https://img.shields.io/badge/License-CC_BY--NC--ND_4.0-66727d?style=flat-square)](LICENSE)

[**Open the workbench**](https://jaeboklee94.github.io/corridor-mapper/drf.html) · [**Comparison protocol**](THRESHOLD_PROTOCOL.md) · [**Reproduce locally**](#reproduce-locally)

</div>

**Active comparison:** EchoSpline (multi-echo cubic B-spline fit) and WM-P (wall mapping with pair tracking).

Default measurement noise (local and shared): position SD **0 m** (implementing the negligible localization noise assumed by Jung et al., §II-C) and echo-range SD **0.40 m** (wall reconstruction in §VI-A). The default range-noise sweep uses 0.40, 0.70 and 1.00 m. Explicit values in replay links and exports retain their original meaning. Published thresholds below were selected under their documented noise conditions.

The left pane fits one smooth wall to measured ranges. The right pane shows WM-P fragment decisions and optional gap interpolation.

EchoMap is developed by **Jaebok Lee, Wireless Systems Laboratory, Hanyang University**. It studies a question in collaborative sensing: can noisy, unlabeled path lengths distinguish a wall patch from a plausible geometric alternative?

The browser generates curved walls, vehicle motion, and specular/diffuse returns. Two non-learning estimators process the **same measured prefix**, while a separate evaluator measures agreement with simulated truth. Computation runs locally in Web Workers; no model service or training dataset is required to run an experiment.

## Explore the evidence

| Capability | What you can inspect |
|:--|:--|
| Compare two methods | Linked maps, common axes and snapshot, separate decisions and metrics |
| Inspect ambiguity | EchoSpline fits one wall; WM-P reports supported, held and rejected hypotheses |
| Replay the measurement history | Advance one snapshot, pause, replay, or inspect any completed prefix |
| Control the scene | 2–10 vehicles, 1–120 snapshots, one or two walls, position/range noise and scattering |
| Run paired sweeps | Both methods, fixed thresholds, current duration; mean and sample SD across seeds |
| Save the experiment | Shared settings URL, JSON with provenance, per-method CSV, 300 dpi field PNG |

The interface uses English labels, light and dark themes, equal spatial scales, and colour plus line/marker shape to distinguish layers. Camera changes affect presentation, not inferred geometry.

## Two estimators, one input contract

For transmitter position $p_i$, receiver position $p_j$ and a possible reflection point $s$, the ideal bistatic path length is

$$d = \lVert s-p_i\rVert_2 + \lVert s-p_j\rVert_2.$$

A single range defines an ellipse. Multiple measurements accumulate a **Direct Residual Field (DRF)**, from which each estimator proposes local surface candidates. A bright field peak is a proposal, not wall confirmation.

| | EchoSpline | WM-P |
|---|---|---|
| Estimate | Cubic B-spline fitted to stationary multi-echo path lengths | Locally tracked wall fragments and mirror hypotheses |
| Controls | Knot spacing (2 or 4 m), support reach (1–12 m) | Fleet-specific operating point, optional gap interpolation |
| Scope | One smooth wall per map; the paper preset uses the upper solution. Other scenes test both signs. | Multiple supported fragments can coexist. |

Each snapshot uses its measured prefix. Five linked observations are needed to initialise EchoSpline. Its spline is the native map; the sidebar interpolation toggle applies to WM-P only. An unresolved mirrored solution or insufficient support can give an empty map.

### Historical WM-F calibration

For three vehicles, WM-F uses a threshold of 28 selected on 120 opening and branch scenes and tested on 120 separate scenes. The original operating points in the following table come from **exploratory tuning on 200 synthetic scenes**, not an independent test. They maximise observed-wall recall subject to empirical mean grouped-fragment FP ≤ 1% in that tuning set.

| Tuning-only result | WM-P | WM-F |
|:--|--:|--:|
| Mean grouped-fragment FP | 0.992% | 0.792% |
| Mean observed-wall recall | 58.70% | 2.57% |
| Scenes with an empty estimate | 0% | 43.5% |

These are archived Python tuning aggregates, **not a fresh benchmark of the current browser release**. They used 3 vehicles, position SD 0 m, range SD 0.1 m, 120 snapshots and the earlier trajectory. Neither method simultaneously met the empirical FP ≤ 1% and recall ≥ 60% targets; neither has an LTT-certified error bound. WM-F's low coverage at this threshold is part of the result.

The original 54-scene set was initially used for evaluation and later reused for development. Its old results must not be advertised as held-out evidence for the current method. It used 3 vehicles and position SD 0.1 m. Localhost defaults to the same fleet size (3); the public site defaults to 10. The tuning distribution differs from the current generator even at 3 vehicles.

[Read the complete protocol and distribution differences](THRESHOLD_PROTOCOL.md) · [Inspect the tuning record and source hashes](validation/threshold-tuning-20261020.json) · [Read the historical study](PSPT_VALIDATION.md)

## Read the map and metrics

- **Supported** means sufficient measurement evidence under the method's model. It does not authenticate an echo source or guarantee a true wall.
- **Centre precision** is the fraction of supported centres within 0.4 m of a true wall. It is undefined for an empty estimate.
- **Observed recall** is the fraction of observed wall samples within 0.4 m of supported patches. A wall sample is observed if it lies within 1 m of a generated reflection point from the measured prefix.
- **Map F₁ (%)**, the default table and history metric, uses the displayed reconstruction: precision is the fraction of estimated arc length within 0.4 m of truth; recall is the fraction of all true-wall samples within 0.4 m of the estimate, including unobserved sections. Their harmonic mean is zero for an empty map with nonempty truth. True-wall components are sampled separately at ≤5 cm. This score does not certify connectivity or open passages.
- **Raw surface F₁** combines sampled-patch precision and observed recall. Overlapping patch samples count repeatedly in surface precision.
- **First support** records centre precision at each candidate's first support decision. Later corrections do not erase an earlier error.
- **P95 distance** and **off-wall centres** describe supported-centre error. They are not the grouped-fragment loss used for tuning.

D̄ is the mean residual density in m⁻². β̂ is a dimensionless field-contrast index, not a probability. True walls and reflection points are optional evaluation overlays. The WM-P interpolation menu includes **Extended centre spline** selected. The menu also offers **Extended linear** for a geometric comparison. Turning WM-P interpolation off shows its supported fragments. Explicit older share links still restore Gap Hermite, Linear or Centre spline for reproducibility.

In the legacy Gap Hermite mode, across short gaps the curve matches the local tangent at each accepted fragment endpoint if they describe one bend. If fitting those tangents would reverse curvature inside the gap, the map retains the straight chord. Both methods join unambiguous, aligned endpoints up to the nominal length of the shorter fragment. For larger gaps, both Gap Hermite and Linear also accept a unique chord when its two tangents meet the same 15° alignment limit and measured ranges repeatedly support every metre of the gap. Each bin requires at least four vehicle pairs, a 75% range-match rate and a 50 percentage-point lead over both displaced-range hypotheses in three distinct snapshots. Both modes retain the straight chord in those larger gaps because the measurement check verifies that geometry. The optional Extended linear view can also join exposed endpoints within four shorter fragment lengths and 45°, skipping occupied or ambiguous gaps. It can bridge real openings; its extra links are evaluated separately. A dotted line marks the inferred gap. Map recall includes this line, while observed recall uses the supported fragments alone.

**Centre spline** reconstructs a wall through the estimated centres and tangents of supported fragments in the current snapshot. On either side it keeps only reciprocal, uniquely nearest centres when both tangents and their connecting direction agree within 15°. Centres beyond 4 m qualify only if the same pair already has a unique exposed endpoint gap confirmed against past measured ranges. The exception changes association, not the interpolating cubic. Each cubic replaces the two inward halves; the free ends and isolated fragments keep their original geometry. No true walls, future observations or known branch labels enter the reconstruction. Collinear openings can be crossed. Explicit legacy links can reproduce this mode. Centre spline reports total map length and total off-wall length; the gap modes report only added lengths. All modes use the same observed-wall mask and 0.4 m tolerance for map recall.

**Extended centre spline** starts from Centre spline. For a unique pair of unused tips, it checks the centre-to-tip, gap and tip-to-centre sections of the cubic against past measured vehicle poses and ranges. Each section is divided into cells no longer than 0.5 m. Four or more distinct vehicle pairs in a snapshot must meet the existing 75% hit and 50 percentage-point control-margin criteria; every cell needs three successful snapshots, with no cell padding. If the entire cubic is unsupported, only a separately checked tip-to-tip cubic can be added, keeping both existing half-fragments. Unsupported gaps remain open. The table and history compare total reconstructed geometry with raw fragments at the same time. If several eligible tips already belong to the same chain, only its nearer free end can be considered; all farther rivals must use already linked sides. For this exception, the existing half-fragments are preserved. Every gap cell of at most 0.5 m needs three distinct matching snapshots (at least 3 pairs each, 4 in at least two of those snapshots, 12 pairs counted across the three). Every cell of at most 1 m independently needs the original 4-pair/3-snapshot check. Distinct branches and cycles are excluded from this exception. With three vehicles there are only three distinct pairs per snapshot: the four-pair extension checks cannot pass, but the ordinary short centre links still apply.


## Run and share an experiment

1. [Open EchoMap](https://jaeboklee94.github.io/corridor-mapper/drf.html), choose settings, and select **Run comparison**.
2. Use **Compare both** or enlarge either method. Replay completed snapshots to inspect when support first appears.
3. Open **Experiments, diagnostics & exports** for paired sweeps and post-hoc scattering diagnostics.
4. Choose **Share experiment** to copy a seeded settings URL, or download JSON/CSV to retain results.

**New map & run** draws a new seed and four new wall geometry values within their input limits and steps, then runs with your other settings. It favors larger shape amplitudes and shorter shape spacing so winding walls appear more often. Both roughness fields are sampled uniformly. **Reset & run** repeats the comparison with the same seed and settings.

New visits use **3 vehicles on localhost** and **10 on the shared site**, with a 100 m upper wall, 100 snapshots, straight vehicle tracks (1 m per snapshot), specular returns, 0.6 m range resolution and interpolation off. On this straight route, WM-P uses a log-score threshold of 6.0 for 3 vehicles and 6.5 for 10. See [the comparison protocol](THRESHOLD_PROTOCOL.md) for their tracking parameters and independent test results. Shared URLs preserve their explicit settings, including seed, fleet size and snapshot count, on reload. An unseeded visit chooses a new seed. A URL shares settings, not computed outputs or an immutable software revision; retain the JSON and repository commit for a research record.

In **Both walls**, the upper and lower boundaries have independent large-scale curves and small-scale perturbations. A constant vertical shift, applied only when needed, keeps their minimum vertical separation above 6 m without bending or clipping either curve. The route follows the midpoint of the finished walls with its full ±2 m lateral oscillation. The 6 m gap covers this 4 m motion envelope plus 1 m vertical truth-pose clearance on each side, for all supported vehicles and phases. Existing accepted seed maps retain their original geometry and tracks. If the initial 256 draws fail, the generator can translate a wall vertically to fit the domain. On a single curved route it can shift the fleet away from the wall to maintain 1 m clearance. On the straight route it places the tracks at least 3 m below the wall.

The corridor-following scene spans x = 0–80 m. Vehicles advance ⅔ m in x per snapshot, so 120 snapshots cover 80 m from their initial positions. Physical time per snapshot is unspecified. Large fleets cost more: 10 vehicles produce 45 unordered pairs per snapshot. Use progress, pause and cancel rather than interpreting elapsed browser time as a method benchmark.

## Reproduce locally

The recorded development environment is **Node.js 26.7.0**. Install the pinned development dependencies, build the offline bundle, and run the full reference checks:

```sh
git clone https://github.com/JaebokLee94/corridor-mapper.git
cd corridor-mapper
npm ci
npm run build:drf-offline
PSPT_FULL_PARITY=1 npm test
node build-pages.mjs
python3 -m http.server 8871 --bind 127.0.0.1 --directory _site
```

Open [localhost:8871/drf.html](http://127.0.0.1:8871/drf.html). For local-file use, open the repository's `drf.html` after rebuilding the offline bundle. Rebuild it whenever runtime sources change.

[Release verification record](validation/2026-10-22/protocol-audit.json).

The tests cover analytic geometry and likelihood cases, frozen Python checkpoints, causal prefixes, truth exclusion, paired sweep/export contracts, and bundle/deployment integrity. Historical SURF hash fixtures are platform sensitive; CI runs the full suite on macOS and the current DRF suite on Linux. Tests establish the properties they check, not physical-sensor performance or an error-rate guarantee. The 200-scene raw tuning archive is not bundled, so `npm test` does not regenerate its table.

### Compute independently of the browser

To keep comparisons and sweeps running when the tab is hidden or closed, use the local Node service:

```sh
npm run start:compute -- --port 9174 --workers 4
```

Open [localhost:9174/drf.html](http://127.0.0.1:9174/drf.html). The same interface receives computed snapshots as they finish. A comparison runs sequentially in a Node worker; a sweep runs up to four independent experiments in parallel. Closing the tab disconnects the viewer without cancelling calculation. Opening or refreshing the page stays idle until an explicit Run or Step action. Run comparison or Run sweep reconnects to an active job of the same type; a completed job is not replayed automatically, and the next Run starts a new calculation. Pause, Step and Cancel are explicit server commands.

The service binds to loopback only. It accepts one active comparison or sweep group, retains the latest two completed jobs for up to 24 hours, and limits each job's cached messages to 512 MiB. Node restart, logout, or shutdown does not resume a previous job. Browser-independent scheduling does not prevent OS sleep or thermal throttling. The public GitHub Pages site and offline file continue to calculate in browser workers; they do not use this local service automatically.

The same Node worker architecture can run on a cloud VM, with HTTPS, authenticated access, persistent job storage and an approved deployment configuration added before exposing it to other machines. No cloud account or paid resource is created by this command.

An opt-in benchmark compares numerical digests for the scenario and every snapshot, and reports computation separately from verification:

```sh
npm run bench:drf -- --input experiment-input.json --output after.json
```

Use a normalized input JSON and identical inputs, machine and runtime for before/after measurements. The benchmark also supports `--source /path/to/baseline` and `--expected before.json`. It is not run as part of the regular unit test suite.

## Scope and research limits

This is a **synthetic, measurement-level simulator**, not an RF waveform or hardware validation platform. The reported noise SDs match those used to generate observations. Controlled noise/model-mismatch experiments are not implemented; curved walls, finite patches and scattering can still differ from the estimators' assumptions.

Mirror ambiguity, insufficient noncollinear geometry and noisy pose information can leave candidates unresolved or produce false support. Two vehicles cannot pass WM-P's instantaneous noncollinearity guard. A high final precision can coexist with poor coverage, empty estimates or earlier false decisions. Current experiments provide no claim of robustness to unspecified mismatch, real cave performance or complete wall recovery.

## Source and evidence map

| Location | Purpose |
|:--|:--|
| [`drf.html`](drf.html), [`drf/`](drf/) | Current application, simulator, estimators and post-hoc evaluation |
| [`drf/echo-comparison.mjs`](drf/echo-comparison.mjs) | Live straight-route WM-P profiles; [shared and historical thresholds](drf/comparison.mjs) |
| [`THRESHOLD_PROTOCOL.md`](THRESHOLD_PROTOCOL.md) | Current selection rules, dataset roles and export definitions |
| [`tests/drf/`](tests/drf/) | Numerical, causal, integration and browser-support checks |
| [`PSPT_VALIDATION.md`](PSPT_VALIDATION.md) | Historical Python study and JavaScript port evidence |
| [`DRF_METHOD.md`](DRF_METHOD.md), [`DRF_VALIDATION.md`](DRF_VALIDATION.md) | Archived field-method evidence under older protocols |
| [`build-pages.mjs`](build-pages.mjs) | Runtime-only Pages package; excludes old pages and legacy peak evaluation |

For a reproducible issue, include the shared URL or JSON, repository commit, browser/OS, and first snapshot where the result differs from your expectation. Numerical counterexamples and clear reproduction steps are especially useful. [Report an issue](https://github.com/JaebokLee94/corridor-mapper/issues).

If you use EchoMap in research, cite this repository with its commit hash and access date, and report the method thresholds, generator settings and evaluation definitions. A browser screenshot alone is not a reproducibility record.

## License

Copyright © 2026 Jaebok Lee, Hanyang University. **CC BY-NC-ND 4.0** applies; see [LICENSE](LICENSE) for terms and separate licensing contact details.
