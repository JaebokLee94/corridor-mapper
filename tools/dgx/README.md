# EchoMap local and batch measurement generation

The H200 computes double-precision diffuse weights for all vehicle pairs and wall cells of a snapshot. Linux Node workers run the original specular solver, seeded Poisson and path sampling, visibility tests and observation model. The client fetches 12-snapshot blocks over a loopback SSH tunnel and orders them by snapshot before exposing the scenario to the existing estimators. The simulator starts the estimator once the complete scenario arrives. For eligible seeds 1–10 it reads existing physical paths first. On a miss those seeds can cache DGX-generated physical paths separately and apply the requested noise locally.

The remote requires a CUDA-capable Linux container, the CUDA toolkit and the headers and executable of Node 26.7 (the tested Mac/Linux version). Build in the project root using your actual Node header directory:

```sh
/usr/local/cuda/bin/nvcc -O3 -arch=sm_90 --fmad=false -shared -Xcompiler=-fPIC -Iinclude/node tools/dgx/weights.cu -o tools/dgx/weights.node
node tools/dgx/service.mjs
```

The service binds only to 127.0.0.1, defaults to port 18902 and six processes, and accepts normalized settings. From the Mac, forward a loopback port:

```sh
ssh -NT -o ExitOnForwardFailure=yes -L 127.0.0.1:18901:127.0.0.1:18902 hanyang-dgx
```

The local compute server workers check `~/.config/echomap/dgx.json` for `{"url":"http://127.0.0.1:18901"}`. ECHOMAP_DGX_URL overrides this setting. An empty value uses the CPU. Public browser execution does not read this file. If the tunnel or service is unavailable the local worker retries the scenario on the CPU and records `cpu-fallback`. Set ECHOMAP_DGX_STRICT=1 in a measurement benchmark to propagate an error instead. Responses from the two machines need not have identical last bits.

For a server-side batch, put one simulator input object per line in settings.jsonl, then run on the DGX with the service running:

```sh
ECHOMAP_DGX_URL=http://127.0.0.1:18902 ECHOMAP_DGX_STRICT=1 node tools/dgx/batch.mjs < settings.jsonl > results.jsonl
```

Use a run-specific directory on the allocated data volume for the input, output and stderr log. For repeatable timing on the Mac, `ECHOMAP_DGX_URL=http://127.0.0.1:18901 node tools/dgx/benchmark.mjs` compares fresh CPU generation and GPU requests including response transfer and decoding. The reported times exclude wall estimation and browser rendering.

GitHub Pages serves the H200-generated bank for the ten default roughness-2 seeds. On an eligible miss, its run and sweep workers request noise-independent physical paths from the dedicated HTTPS relay, then apply the original pose/range noise and run estimation in the browser. GPU availability and quotas do not change estimator settings. A cache hit can also reuse locally saved compatible paths. Other historical bank roughness presets retain their original measurements. To rebuild the GPU preset bank, set ECHOMAP_BUILD_DGX_URL to the private loopback endpoint and run node tools/build-truth-bank.mjs --roughness 2.

The relay accepts only bounded physical-measurement blocks and authorizes its single outbound DGX agent with a private secret; no public SSH, shell or local job-control endpoints. Public budget: two blocks in flight, twelve snapshots per block, two default full runs per client per ten minutes and twenty globally at ten vehicles. Quota units scale with pair count, with a minimum charge per request. Public live generation supports up to ten vehicles, roughness up to ten degrees, intensity up to fifteen and cell spacing at least 0.02 m. Zero scattering needs no GPU. Busy, offline and out-of-budget requests fall back to browser generation. Research batches on the loopback service do not use public quotas.

On container restart, restart the localhost CUDA service and then run node tools/dgx/public/agent.mjs with ECHOMAP_RELAY (the relay's wss /agent URL) and the private ECHOMAP_AGENT_KEY supplied from a protected file. Never put this key in a page, a URL or source control. The agent reconnects on a network interruption; it cannot run while the container is stopped.
