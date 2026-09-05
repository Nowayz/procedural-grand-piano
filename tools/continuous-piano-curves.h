#ifndef CONTINUOUS_PIANO_CURVES_H
#define CONTINUOUS_PIANO_CURVES_H

#include <math.h>

/* Stable evaluation of log(1 + exp(x)), including either asymptote. */
static inline double piano_softplus(double x) {
 return fmax(x, 0) + log1p(exp(-fabs(x)));
}

/* Analytic saturation, with an exponentially small change away from the ends.
 * Unlike a hard clamp this preserves derivatives at the calibration limits. */
static inline double piano_smooth_limit(double x, double low, double high, double width) {
 return low + width * (piano_softplus((x - low) / width) - piano_softplus((x - high) / width));
}

/* Clenshaw evaluates one global polynomial; entries are basis coefficients,
 * never values at sampled positions. x must stay in [-1, 1]. */
static inline double piano_chebyshev(const double *coefficients, int count, double x) {
 double next = 0, following = 0;
 for (int degree = count - 1; degree > 0; --degree) {
  double current = coefficients[degree] + 2 * x * next - following;
  following = next;
  next = current;
 }
 return coefficients[0] + x * next - following;
}

#endif
