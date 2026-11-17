#pragma once
// Preserve the Eigen 5.0.1 scalar FP64 dot-product order while running independent
// right-hand sides in SIMD lanes. Reassociating dot products can change the GP optimizer's path.
#if defined(__wasm_simd128__) && EIGEN_MAJOR_VERSION == 5 && EIGEN_MINOR_VERSION == 0 &&                   \
    EIGEN_PATCH_VERSION == 1
#include <wasm_simd128.h>

namespace Eigen::internal {
template <class Index, class Mapper> struct gebp_kernel<double, double, Index, Mapper, 1, 4, false, false> {
  // Conjugating a real right-hand side selects the unmodified Eigen implementation for tails.
  using Original = gebp_kernel<double, double, Index, Mapper, 1, 4, false, true>;
  template <int Rows>
  static void tile(const Mapper &result, const double *a, const double *b, Index i, Index j, Index depth,
                   Index strideA, double alpha) {
    v128_t even[Rows][2], odd[Rows][2];
    for (int r = 0; r < Rows; ++r)
      for (int c = 0; c < 2; ++c)
        even[r][c] = odd[r][c] = wasm_f64x2_splat(0.0);
    // Eigen accumulates even and odd terms separately in complete eight-term panels.
    const Index stop = depth - depth % 8;
    for (Index k = 0; k < stop; k += 2) {
      const v128_t b0 = wasm_v128_load(b + 4 * k), b1 = wasm_v128_load(b + 4 * k + 2);
      const v128_t b2 = wasm_v128_load(b + 4 * k + 4), b3 = wasm_v128_load(b + 4 * k + 6);
      for (int r = 0; r < Rows; ++r) {
        const v128_t av = wasm_f64x2_splat(a[r * strideA + k]),
                     aw = wasm_f64x2_splat(a[r * strideA + k + 1]);
        even[r][0] = wasm_f64x2_add(even[r][0], wasm_f64x2_mul(av, b0));
        even[r][1] = wasm_f64x2_add(even[r][1], wasm_f64x2_mul(av, b1));
        odd[r][0] = wasm_f64x2_add(odd[r][0], wasm_f64x2_mul(aw, b2));
        odd[r][1] = wasm_f64x2_add(odd[r][1], wasm_f64x2_mul(aw, b3));
      }
    }
    for (int r = 0; r < Rows; ++r)
      for (int c = 0; c < 2; ++c)
        even[r][c] = wasm_f64x2_add(even[r][c], odd[r][c]);
    for (Index k = stop; k < depth; ++k) {
      const v128_t b0 = wasm_v128_load(b + 4 * k), b1 = wasm_v128_load(b + 4 * k + 2);
      for (int r = 0; r < Rows; ++r) {
        const v128_t av = wasm_f64x2_splat(a[r * strideA + k]);
        even[r][0] = wasm_f64x2_add(even[r][0], wasm_f64x2_mul(av, b0));
        even[r][1] = wasm_f64x2_add(even[r][1], wasm_f64x2_mul(av, b1));
      }
    }
    for (int r = 0; r < Rows; ++r) {
      result(i + r, j) += alpha * wasm_f64x2_extract_lane(even[r][0], 0);
      result(i + r, j + 1) += alpha * wasm_f64x2_extract_lane(even[r][0], 1);
      result(i + r, j + 2) += alpha * wasm_f64x2_extract_lane(even[r][1], 0);
      result(i + r, j + 3) += alpha * wasm_f64x2_extract_lane(even[r][1], 1);
    }
  }

  void operator()(const Mapper &result, const double *a, const double *b, Index rows, Index depth,
                  Index cols, double alpha, Index strideA = -1, Index strideB = -1, Index offsetA = 0,
                  Index offsetB = 0) {
    if (cols < 4 || rows < 4 || depth < 8) {
      Original{}(result, a, b, rows, depth, cols, alpha, strideA, strideB, offsetA, offsetB);
      return;
    }
    if (strideA == -1)
      strideA = depth;
    if (strideB == -1)
      strideB = depth;
    const Index full = cols - cols % 4;
    for (Index j = 0; j < full; j += 4) {
      // Solving against the identity produces entire packed panels of exact zeros.
      const double *panel = b + j * strideB + 4 * offsetB;
      Index k = 0;
      while (k < depth && panel[4 * k] == 0 && panel[4 * k + 1] == 0 && panel[4 * k + 2] == 0 &&
             panel[4 * k + 3] == 0)
        ++k;
      if (k == depth)
        continue;
      Index i = 0;
      for (; i + 4 <= rows; i += 4)
        tile<4>(result, a + i * strideA + offsetA, panel, i, j, depth, strideA, alpha);
      for (; i < rows; ++i)
        tile<1>(result, a + i * strideA + offsetA, panel, i, j, depth, strideA, alpha);
    }
    if (full != cols)
      Original{}(result.getSubMapper(0, full), a, b + full * strideB, rows, depth, cols - full, alpha,
                 strideA, strideB, offsetA, offsetB);
  }
};
} // namespace Eigen::internal

#endif
