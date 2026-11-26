// Sample ratio mismatch: chi-square goodness of fit of the observed identities
// per variation against the split configured on the experiment.

/** Regularised upper incomplete gamma function Q(a, x). */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const lnGamma = (z: number): number => {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = z;
    let tmp = z + 5.5;
    tmp -= (z + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (const cj of c) ser += cj / ++y;
    return -tmp + Math.log((2.5066282746310005 * ser) / z);
  };
  if (x < a + 1) {
    // Series for P(a, x).
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  // Continued fraction for Q(a, x) (modified Lentz).
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/** P(X >= chi2) for a chi-square distribution with `df` degrees of freedom. */
export function chiSquarePValue(chi2: number, df: number): number {
  if (df <= 0) return 1;
  return Math.min(1, Math.max(0, gammaQ(df / 2, chi2 / 2)));
}

export interface SrmArm { label: string; observed: number; expected: number }
export interface SrmResult { chi2: number; df: number; pValue: number; total: number; arms: SrmArm[] }

/**
 * @param observed identities per variation label
 * @param split configured share per variation label (any positive scale; normalised here)
 */
export function sampleRatioTest(observed: Record<string, number>, split: Record<string, number>): SrmResult | null {
  const labels = Object.keys(split).filter((l) => split[l] > 0);
  const shareTotal = labels.reduce((s, l) => s + split[l], 0);
  const total = labels.reduce((s, l) => s + (observed[l] ?? 0), 0);
  if (labels.length < 2 || shareTotal <= 0 || total <= 0) return null;
  let chi2 = 0;
  const arms: SrmArm[] = labels.map((label) => {
    const expected = (total * split[label]) / shareTotal;
    const obs = observed[label] ?? 0;
    chi2 += (obs - expected) ** 2 / expected;
    return { label, observed: obs, expected };
  });
  const df = labels.length - 1;
  return { chi2, df, pValue: chiSquarePValue(chi2, df), total, arms };
}

/** Standard normal cumulative distribution function. */
export function normalCdf(z: number): number {
  // Abramowitz and Stegun 7.1.26 on erf, accurate to about 1e-7.
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}
