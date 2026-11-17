#!/bin/sh
# Pass the Eigen includes and, to refresh frozen weights as well, the research checkpoint directory.
set -eu
cd "$(dirname "$0")/../.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL https://raw.githubusercontent.com/scipy/scipy/v1.16.0/scipy/optimize/__lbfgsb.c -o "$tmp/lbfgsb.c"
test "$(shasum -a 256 "$tmp/lbfgsb.c" | cut -d' ' -f1)" = 4b2ca77f4ce0e59af589986716e5a42bbc6f8321ecf4cf76436c210f7c1b4617

# Eigen dispatches its packed double kernel through SSE2. These Emscripten headers
# map those intrinsics to standard WebAssembly SIMD128, including on Apple silicon.
mkdir "$tmp/simd"
for header in xmmintrin.h emmintrin.h; do
    curl -fsSL "https://raw.githubusercontent.com/emscripten-core/emscripten/4.0.10/system/include/compat/$header" -o "$tmp/simd/$header"
done
(cd "$tmp/simd" && shasum -a 256 -c <<'SUM'
dae75290072a1481af7d8bcebb8fd3c2e0dc189a00bad2d3a832358008482a99  xmmintrin.h
b9bbbf4209c3e645f716e3395f52ce5f5405098314cd6c3285ed9d11e3bebba7  emmintrin.h
SUM
)
# Eigen includes the MMX header alongside SSE2 but does not use its x86 intrinsics.
touch "$tmp/simd/mmintrin.h"
zig cc -target wasm32-wasi -O3 -Itools/learned -c "$tmp/lbfgsb.c" -o "$tmp/optimizer.o"
compile() {
    zig c++ -target wasm32-wasi -O3 -msimd128 -fno-exceptions -DEIGEN_DONT_PARALLELIZE -DNDEBUG -I"$eigen" "$@"
}
eigen=$1
compile -c tools/learned/kernels.cpp -o "$tmp/neural.o"
# Give the vectorized Eigen templates a separate namespace from the existing float neural kernels.
compile -I"$tmp/simd" -DEigen=GpEigen -D__SSE__ -D__SSE2__ -Disnanf=__builtin_isnan \
    -Wno-deprecated-declarations -Wno-#pragma-messages -c tools/learned/gaussian-process.cpp -o "$tmp/gp.o"
compile -mexec-model=reactor "$tmp/neural.o" "$tmp/gp.o" "$tmp/optimizer.o" \
    -Wl,--export=multiply -Wl,--export=convolution -Wl,--export=gaussianProcess -Wl,--export=malloc -Wl,--export=free -Wl,--strip-all -o "$tmp/kernels.wasm"
if [ "$#" -gt 1 ]; then
    python3 tools/learned/export.py "$2" "$tmp/kernels.wasm"
else
    python3 - "$tmp/kernels.wasm" <<'PY'
import base64, sys
from pathlib import Path
data = base64.b64encode(Path(sys.argv[1]).read_bytes()).decode('ascii')
Path('drf/models/kernels.mjs').write_text('export default "' + data + '";\n')
PY
fi
