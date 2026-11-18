#!/bin/sh
# Build the small inference kernels with Zig C++ and Eigen. Pass paths to the
# Eigen 5.0.1 headers; pass the checkpoint directory only when refreshing weights.
# The reference binary uses Zig 0.17.1.
set -eu
cd "$(dirname "$0")/../.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL https://raw.githubusercontent.com/scipy/scipy/v1.16.0/scipy/optimize/__lbfgsb.c -o "$tmp/lbfgsb.c"
test "$(shasum -a 256 "$tmp/lbfgsb.c" | cut -d' ' -f1)" = 4b2ca77f4ce0e59af589986716e5a42bbc6f8321ecf4cf76436c210f7c1b4617
zig cc -target wasm32-wasi -O3 -Itools/learned -c "$tmp/lbfgsb.c" -o "$tmp/optimizer.o"
zig c++ -target wasm32-wasi -O3 -msimd128 -mexec-model=reactor -fno-exceptions -DEIGEN_DONT_PARALLELIZE -DNDEBUG -I"$1" tools/learned/kernels.cpp "$tmp/optimizer.o" -Wl,--export=multiply -Wl,--export=convolution -Wl,--export=convolutionXY -Wl,--export=rangeVotes -Wl,--export=gaussianProcess -Wl,--export=malloc -Wl,--export=free -Wl,--strip-all -o "$tmp/kernels.wasm"
if [ "$#" -gt 1 ]; then
    python3 tools/learned/export.py "$2" "$tmp/kernels.wasm"
else
    python3 - "$tmp/kernels.wasm" <<'PYTHON'
import base64, sys
from pathlib import Path
data = base64.b64encode(Path(sys.argv[1]).read_bytes()).decode('ascii')
Path('drf/models/kernels.mjs').write_text('export default "' + data + '";\n')
PYTHON
fi
