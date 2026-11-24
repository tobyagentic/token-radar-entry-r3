// Token Radar round 3 — the model (written fresh for this round).
//
// What it does, in one paragraph: it reads the sealed snapshot, fits TWO
// simple log-linear models on the protocols that already have a token
// (log market cap on log TVL alone, and on log TVL + 7-day growth + age),
// averages their predictions, and ranks the protocols that record no token
// by that average. Every number the dashboard shows — the coefficients, the
// blind-test scores, the odds, the intervals — is computed from the snapshot
// by this file on every run. Nothing about a value is hard-coded except the
// FORM of the model (which features, which transforms); the coefficients
// come from the data.
//
// The entry point is buildRadar(snapshot). main.ts calls it, writes
// board.json and data.js, and copies dashboard/ + screenshots/ to /output.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** A protocol records a token when DefiLlama gives it a CoinGecko id or a ticker. */
export function hasToken(p: Protocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

/** Categories that are a wrapped, staked or bridged product of a token that
 *  already trades, or a centralised exchange: set aside by this rule alone,
 *  never by name. The house's watchlist rule uses the same six categories. */
export const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

export function isSetAside(p: Protocol): boolean {
  return !hasToken(p) && p.category !== null && EXCLUDED_CATEGORIES.has(p.category);
}

export function parseSnapshot(text: string): Snapshot {
  const s = JSON.parse(text) as Snapshot;
  if (!Array.isArray(s.protocols) || !Array.isArray(s.watchlist)) {
    throw new Error('snapshot: protocols and watchlist must be arrays');
  }
  return s;
}

// ---------------------------------------------------------------- utilities

const clip = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

function parseDay(s: string): number {
  const [y, m, d] = s.split('-').map((v) => Number(v));
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/** Age in years at the snapshot date; null when DefiLlama reports no listed date. */
export function ageYears(p: Protocol, asOfDay: number): number | null {
  if (p.listed_at === null) return null;
  return (asOfDay - parseDay(p.listed_at)) / 365.25;
}

/** 7-day TVL growth as a fraction, winsorised; 0 when unreported. */
export function growthOf(p: Protocol): number {
  if (p.change_7d === null) return 0;
  return clip(p.change_7d / 100, -0.6, 1.2);
}

/** Feature rows. M0: log TVL alone. M2: log TVL + growth + age. Age defaults
 *  to 1 year when unreported — the same convention the fit was trained with. */
export function features(p: Protocol, asOfDay: number, kind: 'm0' | 'm2'): number[] {
  const a = ageYears(p, asOfDay);
  const age = a === null ? 1.0 : a;
  if (kind === 'm0') return [1, Math.log(p.tvl_usd)];
  return [1, Math.log(p.tvl_usd), growthOf(p), age];
}

/** Solve A x = b by Gaussian elimination with partial pivoting. Throws when
 *  the system is singular, so a degenerate fit fails loudly instead of
 *  silently producing numbers that differ from the offline check. */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-12) throw new Error('solveLinear: singular matrix');
    if (piv !== col) {
      const tmp = M[col]!;
      M[col] = M[piv]!;
      M[piv] = tmp;
    }
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / M[col]![col]!;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let c = r + 1; c < n; c++) s -= M[r]![c]! * x[c]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
}

export interface OlsFit {
  beta: number[];
  residSd: number;
  r2: number;
}

/** Ordinary least squares by the normal equations. */
export function ols(X: number[][], y: number[]): OlsFit {
  const n = y.length;
  const k = X[0]!.length;
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      b[a]! += X[i]![a]! * y[i]!;
      for (let c = 0; c < k; c++) A[a]![c]! += X[i]![a]! * X[i]![c]!;
    }
  }
  const beta = solveLinear(A, b);
  let ssRes = 0;
  let ssTot = 0;
  const mean = y.reduce((s, v) => s + v, 0) / n;
  for (let i = 0; i < n; i++) {
    const pred = dot(beta, X[i]!);
    ssRes += (y[i]! - pred) ** 2;
    ssTot += (y[i]! - mean) ** 2;
  }
  return { beta, residSd: Math.sqrt(ssRes / Math.max(n - k, 1)), r2: 1 - ssRes / ssTot };
}

const dot = (a: number[], b: number[]): number => a.reduce((s, v, i) => s + v * b[i]!, 0);

/** Spearman rank correlation, with average ranks for ties. */
export function spearman(a: number[], b: number[]): number {
  const ranks = (xs: number[]): number[] => {
    const order = xs.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(xs.length).fill(0);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[order[k]![1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const ra = ranks(a);
  const rb = ranks(b);
  const n = a.length;
  const ma = ra.reduce((s, v) => s + v, 0) / n;
  const mb = rb.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i]! - ma) * (rb[i]! - mb);
    da += (ra[i]! - ma) ** 2;
    db += (rb[i]! - mb) ** 2;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

const rmse = (pred: number[], y: number[]): number =>
  Math.sqrt(pred.reduce((s, p, i) => s + (p - y[i]!) ** 2, 0) / y.length);

// ---------------------------------------------------------------- the baselines

/** Round 1's hand-picked rule, reconstructed from its description: a tier
 *  multiple by TVL band, a growth weight of 0.5 and a maturity factor of
 *  0.6–1.0 by age. It is a baseline to beat, not a model we use. */
export function round1Implied(p: Protocol, asOfDay: number): number {
  const tvl = p.tvl_usd;
  const tier = tvl < 100_000_000 ? 0.35 : tvl < 1_000_000_000 ? 0.25 : 0.15;
  const a = ageYears(p, asOfDay);
  const age = a === null ? 1.0 : a;
  const maturity = 0.6 + 0.4 * Math.min(age / 3, 1);
  return tvl * tier * (1 + 0.5 * growthOf(p)) * maturity;
}

// ---------------------------------------------------------------- the fit + validation

export interface ModelValidation {
  wf: { nFit: number; nTest: number; m0: Metric; m2: Metric; avg: Metric; r1: Metric };
  loo: { m0: Metric; m2: Metric; avg: Metric; sigma: number; cov90: number; cov80: number };
  cv5: { m0: Metric; m2: Metric; avg: Metric };
  factors: { wf: number; loo: number; cv5: number };
}

export interface Metric {
  rmse: number;
  spearman: number;
}

export interface FittedModel {
  beta0: number[];
  beta2: number[];
  residSd0: number;
  residSd2: number;
  r2_0: number;
  r2_2: number;
  sigma: number;
  validation: ModelValidation;
  nTrain: number;
}

const WF_SPLIT_DAY = parseDay('2024-02-18');

export function fitAndValidate(train: Protocol[], asOfDay: number): FittedModel {
  const y = train.map((p) => Math.log(p.mcap_usd!));
  const X0 = train.map((p) => features(p, asOfDay, 'm0'));
  const X2 = train.map((p) => features(p, asOfDay, 'm2'));
  const f0 = ols(X0, y);
  const f2 = ols(X2, y);

  const avgPred = (i: number, b0: number[], b2: number[]): number =>
    (dot(b0, X0[i]!) + dot(b2, X2[i]!)) / 2;

  // Walk-forward: fit on protocols listed before 2024-02-18 (unlisted ones
  // cannot be ordered, so they stay in the fit set), predict the rest.
  const testIdx = train
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.listed_at !== null && parseDay(p.listed_at) >= WF_SPLIT_DAY)
    .map(({ i }) => i);
  const testSet = new Set(testIdx);
  const fitIdx = train.map((_, i) => i).filter((i) => !testSet.has(i));
  const wfFit0 = ols(fitIdx.map((i) => X0[i]!), fitIdx.map((i) => y[i]!));
  const wfFit2 = ols(fitIdx.map((i) => X2[i]!), fitIdx.map((i) => y[i]!));
  const wfY = testIdx.map((i) => y[i]!);
  const wfPred = (b0: number[], b2: number[]): number[] =>
    testIdx.map((i) => (dot(b0, X0[i]!) + dot(b2, X2[i]!)) / 2);
  const wf = {
    nFit: fitIdx.length,
    nTest: testIdx.length,
    m0: { rmse: rmse(testIdx.map((i) => dot(wfFit0.beta, X0[i]!)), wfY), spearman: spearman(testIdx.map((i) => dot(wfFit0.beta, X0[i]!)), wfY) },
    m2: { rmse: rmse(testIdx.map((i) => dot(wfFit2.beta, X2[i]!)), wfY), spearman: spearman(testIdx.map((i) => dot(wfFit2.beta, X2[i]!)), wfY) },
    avg: { rmse: rmse(wfPred(wfFit0.beta, wfFit2.beta), wfY), spearman: spearman(wfPred(wfFit0.beta, wfFit2.beta), wfY) },
    r1: { rmse: rmse(testIdx.map((i) => Math.log(round1Implied(train[i]!, asOfDay))), wfY), spearman: spearman(testIdx.map((i) => Math.log(round1Implied(train[i]!, asOfDay))), wfY) },
  };

  // Leave-one-out: refit both models without each row, average the two
  // predictions. The residual SD of these out-of-sample predictions is the
  // sigma the intervals use, and their coverage is the calibration check.
  const looAvg: number[] = [];
  const loo0: number[] = [];
  const loo2: number[] = [];
  for (let i = 0; i < train.length; i++) {
    const idx = train.map((_, j) => j).filter((j) => j !== i);
    const b0 = ols(idx.map((j) => X0[j]!), idx.map((j) => y[j]!)).beta;
    const b2 = ols(idx.map((j) => X2[j]!), idx.map((j) => y[j]!)).beta;
    const p0 = dot(b0, X0[i]!);
    const p2 = dot(b2, X2[i]!);
    loo0.push(p0);
    loo2.push(p2);
    looAvg.push((p0 + p2) / 2);
  }
  const looResid = y.map((v, i) => v - looAvg[i]!);
  const sigma = Math.sqrt(looResid.reduce((s, r) => s + r * r, 0) / (looResid.length - 1));
  const loo = {
    m0: { rmse: rmse(loo0, y), spearman: spearman(loo0, y) },
    m2: { rmse: rmse(loo2, y), spearman: spearman(loo2, y) },
    avg: { rmse: rmse(looAvg, y), spearman: spearman(looAvg, y) },
    sigma,
    cov90: looResid.filter((r) => Math.abs(r) <= 1.6449 * sigma).length / looResid.length,
    cov80: looResid.filter((r) => Math.abs(r) <= 1.2816 * sigma).length / looResid.length,
  };

  // 5-fold cross-validation, folds by slug order (deterministic).
  const order = train.map((_, i) => i).sort((a, b) => (train[a]!.slug < train[b]!.slug ? -1 : 1));
  const folds = [0, 1, 2, 3, 4].map((k) => order.filter((_, j) => j % 5 === k));
  const oof = (kind: 'm0' | 'm2' | 'avg'): number[] => {
    const out = new Array<number>(train.length).fill(0);
    for (const te of folds) {
      const teSet = new Set(te);
      const tr = train.map((_, i) => i).filter((i) => !teSet.has(i));
      const b0 = ols(tr.map((i) => X0[i]!), tr.map((i) => y[i]!)).beta;
      const b2 = ols(tr.map((i) => X2[i]!), tr.map((i) => y[i]!)).beta;
      for (const i of te) {
        out[i] = kind === 'm0' ? dot(b0, X0[i]!) : kind === 'm2' ? dot(b2, X2[i]!) : (dot(b0, X0[i]!) + dot(b2, X2[i]!)) / 2;
      }
    }
    return out;
  };
  const oof0 = oof('m0');
  const oof2 = oof('m2');
  const oofAvg = oof('avg');
  const cv5 = {
    m0: { rmse: rmse(oof0, y), spearman: spearman(oof0, y) },
    m2: { rmse: rmse(oof2, y), spearman: spearman(oof2, y) },
    avg: { rmse: rmse(oofAvg, y), spearman: spearman(oofAvg, y) },
  };

  const r1All = rmse(train.map((p) => Math.log(round1Implied(p, asOfDay))), y);
  return {
    beta0: f0.beta,
    beta2: f2.beta,
    residSd0: f0.residSd,
    residSd2: f2.residSd,
    r2_0: f0.r2,
    r2_2: f2.r2,
    sigma,
    validation: {
      wf,
      loo,
      cv5,
      factors: { wf: wf.r1.rmse / wf.avg.rmse, loo: r1All / loo.avg.rmse, cv5: r1All / cv5.avg.rmse },
    },
    nTrain: train.length,
  };
}

/** The averaged prediction (log value) for a protocol, from a fitted model. */
export function predictLog(p: Protocol, asOfDay: number, m: FittedModel): number {
  return (dot(m.beta0, features(p, asOfDay, 'm0')) + dot(m.beta2, features(p, asOfDay, 'm2'))) / 2;
}

// ---------------------------------------------------------------- token odds

export interface OddsBand {
  loDays: number;
  hiDays: number | null;
  n: number;
  shareNoToken: number;
  smoothed: number;
  forwardOdds: number;
}

/** Pool-adjacent-violators: the smallest non-increasing sequence at least as
 *  close (least squares) to the raw shares. */
function pavaDecreasing(values: number[], weights: number[]): number[] {
  const blocks: { value: number; weight: number; count: number }[] = [];
  for (let i = 0; i < values.length; i++) {
    blocks.push({ value: values[i]!, weight: weights[i]!, count: 1 });
    while (blocks.length >= 2) {
      const a = blocks[blocks.length - 2]!;
      const b = blocks[blocks.length - 1]!;
      if (a.value >= b.value) break;
      const w = a.weight + b.weight;
      blocks.splice(blocks.length - 2, 2, { value: (a.value * a.weight + b.value * b.weight) / w, weight: w, count: a.count + b.count });
    }
  }
  const out: number[] = [];
  for (const b of blocks) for (let i = 0; i < b.count; i++) out.push(b.value);
  return out;
}

export interface Odds {
  bands: OddsBand[];
  medianPreTokenAgeDays: number;
  /** The smoothed survivor curve as (age in days, share still without a
   *  token) points, so the dashboard and the odds share one curve. */
  curve: { ageDays: number; share: number }[];
}

/** The survivor curve at an age in days: linear between the curve's points,
 *  flat outside them. */
function survivorAt(curve: { ageDays: number; share: number }[], days: number): number {
  if (days <= curve[0]!.ageDays) return curve[0]!.share;
  for (let i = 1; i < curve.length; i++) {
    if (days <= curve[i]!.ageDays) {
      const a = curve[i - 1]!;
      const b = curve[i]!;
      if (b.ageDays === a.ageDays) return b.share;
      return a.share + ((b.share - a.share) * (days - a.ageDays)) / (b.ageDays - a.ageDays);
    }
  }
  return curve[curve.length - 1]!.share;
}

/** Forward 1-year launch odds at an age, from a survivor curve. */
function forwardOddsAt(curve: { ageDays: number; share: number }[], days: number): number {
  const s0 = survivorAt(curve, days);
  if (s0 <= 0) return 0;
  return clip(1 - survivorAt(curve, days + 365) / s0, 0, 1);
}

/** Launch odds from the peers' record. The survivor curve is the share of
 *  protocols still without a token at each age, PAVA-smoothed so it never
 *  rises with age, then read as a continuous curve: linear between each
 *  band's median age (flat outside), and a protocol's forward 1-year odds
 *  are 1 − S(age+365)/S(age) on that curve.
 *
 *  Why a curve, not band steps: a step function gives 0% odds wherever a
 *  band is wider than a year (its start and start+365 fall in the same
 *  band) and jumps where the share falls steeply between bands. The curve
 *  reads the same record without those artefacts. */
export function tokenOdds(snapshot: Snapshot, asOfDay: number): Odds {
  const BANDS: [number, number | null][] = [
    [0, 180],
    [180, 365],
    [365, 730],
    [730, 1095],
    [1095, 1500],
    [1500, null],
  ];
  const known = snapshot.protocols
    .map((p) => ({ p, age: ageYears(p, asOfDay) }))
    .filter((r): r is { p: Protocol; age: number } => r.age !== null);
  const preAges = known
    .filter((r) => !hasToken(r.p))
    .map((r) => r.age * 365.25)
    .sort((a, b) => a - b);
  const medianPreTokenAgeDays = preAges.length === 0 ? 516 : preAges[Math.floor(preAges.length / 2)]!;
  const raw: number[] = [];
  const ns: number[] = [];
  const centres: number[] = [];
  for (const [lo, hi] of BANDS) {
    const inBand = known.filter((r) => r.age * 365.25 >= lo && (hi === null || r.age * 365.25 < hi));
    ns.push(inBand.length);
    raw.push(inBand.length === 0 ? 0 : inBand.filter((r) => !hasToken(r.p)).length / inBand.length);
    const ages = inBand.map((r) => r.age * 365.25).sort((a, b) => a - b);
    centres.push(ages.length === 0 ? lo : ages[Math.floor(ages.length / 2)]!);
  }
  const smoothed = pavaDecreasing(raw, ns.map((n) => Math.max(n, 1)));
  const curve = centres.map((ageDays, i) => ({ ageDays: Math.round(ageDays), share: smoothed[i]! }));
  const bands: OddsBand[] = BANDS.map(([lo, hi], i) => ({
    loDays: lo,
    hiDays: hi,
    n: ns[i]!,
    shareNoToken: raw[i]!,
    smoothed: smoothed[i]!,
    forwardOdds: forwardOddsAt(curve, lo),
  }));
  return { bands, medianPreTokenAgeDays, curve };
}

/** A protocol's 1-year launch odds are its age band's forward odds, read from
 *  the survivor curve; unknown age takes the median pre-token age. The band
 *  is the honest resolution: past the curve's last point the record is too
 *  thin to resolve age finer than the band, so exact-age curve reads would
 *  give 0% to the oldest protocols for want of a tail, not from evidence. */
export function oddsFor(p: Protocol, asOfDay: number, odds: Odds): number {
  const a = ageYears(p, asOfDay);
  const days = a === null ? odds.medianPreTokenAgeDays : a * 365.25;
  for (const b of odds.bands) {
    if (days >= b.loDays && (b.hiDays === null || days < b.hiDays)) return b.forwardOdds;
  }
  return odds.bands[odds.bands.length - 1]!.forwardOdds;
}

// ---------------------------------------------------------------- farm plans

export interface FarmPlan {
  steps: string[];
  verdict: string;
  capitalUsd: number;
  gasUsd: number;
  holdDays: number;
  minutes: number;
}

const capitalTier = (tvl: number): number =>
  tvl >= 1_000_000_000 ? 250 : tvl >= 250_000_000 ? 150 : tvl >= 50_000_000 ? 100 : 60;

const holdDaysFor = (age: number | null): number => {
  if (age === null) return 30;
  if (age * 365.25 < 120) return 60;
  if (age * 365.25 < 365) return 45;
  return 30;
};

function actionFor(category: string | null): { verb: string; detail: string } {
  switch (category) {
    case 'Dexs':
      return { verb: 'swap and add liquidity', detail: 'swap half the capital into the pool\'s other token, then add both sides as liquidity' };
    case 'Lending':
      return { verb: 'supply and borrow', detail: 'supply the capital as collateral, then borrow a small amount against it to show usage' };
    case 'Yield':
    case 'Yield Aggregator':
      return { verb: 'deposit into a vault', detail: 'deposit the capital into the protocol\'s main yield vault' };
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
      return { verb: 'deposit into a curated vault', detail: 'deposit the capital into a curator vault that matches your risk appetite' };
    case 'RWA':
      return { verb: 'buy and hold the tokenised asset', detail: 'buy the protocol\'s tokenised asset with the capital and hold it in your wallet' };
    case 'Derivatives':
      return { verb: 'open a small position', detail: 'open a small long position with a fraction of the capital and keep the rest as margin' };
    case 'CDP':
      return { verb: 'mint against collateral', detail: 'lock the capital as collateral and mint a small amount of the protocol\'s stable asset' };
    default:
      return { verb: 'use the app and deposit', detail: 'deposit the capital through the protocol\'s main app flow' };
  }
}

/** A concrete 6-step farm plan. Every number carries its assumption next to
 *  it; the assumptions are the same for every row and are stated on the
 *  dashboard's farm section too. */
export function farmPlan(p: Protocol, asOfDay: number): FarmPlan {
  const chain = p.chains[0] ?? 'Ethereum';
  const capital = capitalTier(p.tvl_usd);
  const hold = holdDaysFor(ageYears(p, asOfDay));
  const weeks = Math.ceil(hold / 7);
  // Assumptions: $2 per simple transaction on a low-fee chain; 3 setup
  // transactions; 1 transaction per weekly visit; $4 to exit in two steps.
  const gas = 3 * 2 + weeks * 2 + 4;
  const minutes = 40 + 10 * weeks;
  const act = actionFor(p.category);
  const steps = [
    `Open a fresh wallet for ${p.name} farming and fund it with $${capital} on ${chain} (the first chain DefiLlama lists for this protocol; a cheaper chain in its list may cost less gas). Assumption: you already hold the chain's gas token; if not, bridge $10 first, about $2 in bridge fees and 10 minutes.`,
    `On ${chain}, ${act.detail} with the $${capital}. Assumption: slippage under 0.5% on a trade this size; check the quote before you sign, and do not proceed if it is worse.`,
    `Confirm the position is live: check that the deposit shows in the app and note the transaction hash, the date and the $${capital} amount in a notebook. Cost: free. Time: 5 minutes.`,
    `Return once a week for ${weeks} weeks: claim or compound any rewards and re-check the position. Assumption: one visit a week, 10 minutes each, $2 in gas per visit.`,
    `Do not move the funds for ${hold} days in total. Assumption: airdrop snapshots reward continuous holding; withdrawing early may reset your history with this protocol.`,
    `After ${hold} days, exit in two steps: withdraw the deposit, then swap back to your starting token. Assumption: exit slippage under 1%; exit gas about $4 in total.`,
  ];
  return {
    steps,
    verdict: `About $${gas} gas in all ($2 per simple transaction assumed), $${capital} capital, hold ${hold} days, about ${minutes} minutes of work. No dollar value is promised: the reader's share of any future drop is unknown.`,
    capitalUsd: capital,
    gasUsd: gas,
    holdDays: hold,
    minutes,
  };
}

// ---------------------------------------------------------------- the board

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  low_usd: number;
  high_usd: number;
  odds_1y: number;
  farm_steps: string[];
  verdict: string;
  watchlist: boolean;
}

export interface RadarData {
  meta: {
    asOf: string;
    source: string;
    model: {
      name: string;
      m0: string;
      m2: string;
      beta0: number[];
      beta2: number[];
      r2_0: number;
      r2_2: number;
      sigma: number;
      nTrain: number;
    };
    validation: ModelValidation;
    oddsBands: OddsBand[];
    medianPreTokenAgeDays: number;
    accounting: { board: number; live: number; setAside: number; total: number; watchlist: number };
    assumptions: string[];
  };
  rows: BoardRow[];
  live: { slug: string; name: string; category: string | null; mcap_usd: number | null; usable: boolean }[];
  setAside: { slug: string; name: string; category: string | null; reason: string }[];
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const asOfDay = parseDay(snapshot.as_of);
  const train = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0);
  const model = fitAndValidate(train, asOfDay);
  const odds = tokenOdds(snapshot, asOfDay);
  const watch = new Set(snapshot.watchlist);

  const boardProtos = snapshot.protocols
    .filter((p) => !hasToken(p) && !isSetAside(p))
    .map((p) => {
      const pred = predictLog(p, asOfDay, model);
      const implied = Math.max(1, Math.round(Math.exp(pred)));
      const lo = Math.max(1, Math.round(Math.exp(pred - 1.6449 * model.sigma)));
      const hi = Math.max(1, Math.round(Math.exp(pred + 1.6449 * model.sigma)));
      return { p, pred, implied, lo, hi };
    })
    .sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : 1));

  const board: BoardRow[] = boardProtos.map((r, i) => {
    const plan = farmPlan(r.p, asOfDay);
    const age = ageYears(r.p, asOfDay);
    return {
      rank: i + 1,
      slug: r.p.slug,
      name: r.p.name,
      category: r.p.category,
      chains: r.p.chains,
      tvl_usd: r.p.tvl_usd,
      change_7d: r.p.change_7d,
      age_days: age === null ? null : Math.round(age * 365.25),
      implied_value_usd: r.implied,
      low_usd: r.lo,
      high_usd: r.hi,
      odds_1y: oddsFor(r.p, asOfDay, odds),
      farm_steps: plan.steps,
      verdict: plan.verdict,
      watchlist: watch.has(r.p.slug),
    };
  });

  const live = snapshot.protocols
    .filter((p) => hasToken(p))
    .sort((a, b) => (b.mcap_usd ?? -1) - (a.mcap_usd ?? -1) || (a.slug < b.slug ? -1 : 1))
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      mcap_usd: p.mcap_usd,
      usable: p.mcap_usd !== null && p.mcap_usd > 0,
    }));

  const setAside = snapshot.protocols
    .filter((p) => isSetAside(p))
    .sort((a, b) => (a.category ?? '') < (b.category ?? '') ? -1 : (a.category ?? '') > (b.category ?? '') ? 1 : a.slug < b.slug ? -1 : 1)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      reason: `Category ${p.category ?? 'none'}: a wrapped, staked, bridged or exchange product, not a protocol still waiting on a launch of its own.`,
    }));

  const radar: RadarData = {
    meta: {
      asOf: snapshot.as_of,
      source: snapshot.source,
      model: {
        name: 'Average of two log-linear fits on the 128 token-bearing protocols',
        m0: 'log(mcap) on log(TVL)',
        m2: 'log(mcap) on log(TVL) + growth + age',
        beta0: model.beta0,
        beta2: model.beta2,
        r2_0: model.r2_0,
        r2_2: model.r2_2,
        sigma: model.sigma,
        nTrain: model.nTrain,
      },
      validation: model.validation,
      oddsBands: odds.bands,
      medianPreTokenAgeDays: Math.round(odds.medianPreTokenAgeDays),
      accounting: {
        board: board.length,
        live: live.length,
        setAside: setAside.length,
        total: snapshot.protocols.length,
        watchlist: snapshot.watchlist.length,
      },
      assumptions: [
        'Gas: $2 per simple transaction on a low-fee chain; 3 setup transactions, 1 per weekly visit, $4 to exit.',
        'Capital tiers by TVL: $250 at $1B+, $150 at $250M+, $100 at $50M+, $60 below.',
        'Hold: 60 days if the protocol is under 120 days old, 45 days under a year, 30 days otherwise; 30 days when the listed date is unknown.',
        'Growth is the 7-day TVL change, clipped to -60%…+120%; unreported growth counts as 0. Age is 1 year when no listed date is reported.',
        'Intervals are prediction ± 1.6449 × the leave-one-out residual SD; they are calibrated on protocols that launched tokens, not on the board.',
      ],
    },
    rows: board,
    live,
    setAside,
  };
  return { board, radar };
}

/** The dashboard's data file: one assignment, deterministic bytes. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}

/** The gate's board rules, checked before anything is written. Returns the
 *  first problem found, or null when the board is acceptable. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100 to 4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const r of board) {
    if (!slugs.has(r.slug)) return `board names ${r.slug}, which the snapshot does not list`;
    if (seen.has(r.slug)) return `board names ${r.slug} twice`;
    seen.add(r.slug);
    if (!r.name) return `board row ${r.slug} has no name`;
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `board row ${r.slug} has a bad implied value`;
    if (r.implied_value_usd > 100_000_000_000_000) return `board row ${r.slug} is over the value cap`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `board row ${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim().length;
      if (t < 20 || t > 600) return `board row ${r.slug} has a farm step of ${t} characters`;
    }
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `ranks are not exactly 1 to ${board.length}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `implied value rises from rank ${i} to ${i + 1}`;
  }
  if (board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) return 'every implied value is the same: not a ranking';
  for (const w of snapshot.watchlist) if (!seen.has(w)) return `watchlist protocol ${w} is missing from the board`;
  return null;
}
