#!/bin/sh
# Build the small inference kernels with Zig C++ and Eigen. Pass paths to the
# eigen3 headers and research checkpoint directory; only converted weights ship.
set -eu
cd "$(dirname "$0")/../.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL https://raw.githubusercontent.com/scipy/scipy/v1.16.0/scipy/optimize/__lbfgsb.c -o "$tmp/lbfgsb.c"
test "$(shasum -a 256 "$tmp/lbfgsb.c" | cut -d' ' -f1)" = 4b2ca77f4ce0e59af589986716e5a42bbc6f8321ecf4cf76436c210f7c1b4617
zig cc -target wasm32-wasi -O3 -Itools/learned -c "$tmp/lbfgsb.c" -o "$tmp/optimizer.o"
zig c++ -target wasm32-wasi -O3 -msimd128 -mexec-model=reactor -fno-exceptions -DEIGEN_DONT_PARALLELIZE -DNDEBUG -I"$1" tools/learned/kernels.cpp "$tmp/optimizer.o" -Wl,--export=multiply -Wl,--export=convolution -Wl,--export=gaussianProcess -Wl,--export=malloc -Wl,--export=free -Wl,--strip-all -o "$tmp/kernels.wasm"
python3 tools/learned/export.py "$2" "$tmp/kernels.wasm"
