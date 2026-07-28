export type Bar = {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type SignalResult = {
  score: number;
  confidence: number;
  verdict: "BUY" | "HOLD" | "SELL";
  referencePrice: number;
  volatilityPercent: number;
  suggestedExposurePercent: number;
  signals: Record<string, number | string | boolean>;
  explanation: string;
};

const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const ema = (values: number[], period: number) => {
  if (!values.length) return 0;
  const multiplier = 2 / (period + 1);
  return values.slice(1).reduce((current, value) => (value * multiplier) + (current * (1 - multiplier)), values[0]);
};
const rsi = (values: number[], period = 14) => {
  if (values.length <= period) return 50;
  const changes = values.slice(-period - 1).slice(1).map((value, index) => value - values.slice(-period - 1)[index]);
  const gains = average(changes.map(change => Math.max(0, change)));
  const losses = average(changes.map(change => Math.max(0, -change)));
  if (losses === 0) return 100;
  return 100 - (100 / (1 + (gains / losses)));
};
const atr = (bars: Bar[], period = 14) => {
  if (bars.length < 2) return 0;
  const ranges = bars.slice(1).map((bar, index) => Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - bars[index].close),
    Math.abs(bar.low - bars[index].close)
  ));
  return average(ranges.slice(-period));
};
const macdHistogram = (values: number[]) => {
  if (values.length < 35) return 0;
  const macdSeries = values.map((_, index) => {
    const subset = values.slice(0, index + 1);
    return ema(subset, 12) - ema(subset, 26);
  });
  return macdSeries.at(-1)! - ema(macdSeries.slice(-18), 9);
};
const percentChange = (from: number, to: number) => from ? ((to / from) - 1) * 100 : 0;

export function analyse(shortBarsNewest: Bar[], longBarsNewest: Bar[], benchmarkNewest: Bar[], held: boolean): SignalResult {
  const shortBars = [...shortBarsNewest].reverse();
  const longBars = [...longBarsNewest].reverse();
  const benchmark = [...benchmarkNewest].reverse();
  const closes = shortBars.map(bar => bar.close);
  const longCloses = longBars.map(bar => bar.close);
  const benchmarkCloses = benchmark.map(bar => bar.close);
  const price = closes.at(-1) || 0;

  if (shortBars.length < 35 || longBars.length < 35 || benchmark.length < 35 || !price) {
    return {
      score: 50, confidence: 0, verdict: "HOLD", referencePrice: price,
      volatilityPercent: 0, suggestedExposurePercent: 0,
      signals: { dataQuality: "insufficient" },
      explanation: "No trade: the model did not receive enough complete multi-timeframe market data."
    };
  }

  const fastTrend = percentChange(ema(closes, 21), ema(closes, 8));
  const slowTrend = percentChange(ema(longCloses, 30), ema(longCloses, 10));
  const benchmarkTrend = percentChange(ema(benchmarkCloses, 30), ema(benchmarkCloses, 10));
  const currentRsi = rsi(closes);
  const macd = macdHistogram(closes);
  const volatilityPercent = price ? (atr(shortBars) / price) * 100 : 0;
  const priorHigh = Math.max(...shortBars.slice(-21, -1).map(bar => bar.high));
  const breakoutPercent = percentChange(priorHigh, price);
  const recentVolume = average(shortBars.slice(-3).map(bar => bar.volume).filter(Boolean));
  const normalVolume = average(shortBars.slice(-20).map(bar => bar.volume).filter(Boolean));
  const volumeRatio = normalVolume ? recentVolume / normalVolume : 1;
  const impulse = percentChange(closes.at(-7) || price, price);

  let score = 50;
  score += clamp(fastTrend * 9, -14, 14);
  score += clamp(slowTrend * 7, -15, 15);
  score += clamp(benchmarkTrend * 5, -10, 10);
  score += clamp(macd / price * 12000, -8, 8);
  score += breakoutPercent > 0 ? clamp(5 + breakoutPercent * 2, 0, 8) : clamp(breakoutPercent * 2, -6, 0);
  score += volumeRatio > 1.15 ? 4 : volumeRatio < 0.7 ? -3 : 0;
  score += currentRsi >= 52 && currentRsi <= 68 ? 7 : currentRsi > 78 ? -12 : currentRsi < 34 ? 3 : 0;
  score += clamp(impulse * 2, -8, 8);
  score -= volatilityPercent > 1.8 ? clamp((volatilityPercent - 1.8) * 5, 0, 10) : 0;
  score = Math.round(clamp(score, 0, 100));

  const riskOff = benchmarkTrend < -0.15;
  const buyAgreement = fastTrend > 0 && slowTrend > 0 && macd > 0 && !riskOff;
  const sellAgreement = fastTrend < 0 && (slowTrend < 0 || macd < 0);
  const verdict = held
    ? (score <= 38 || sellAgreement ? "SELL" : "HOLD")
    : (score >= 60 && buyAgreement ? "BUY" : "HOLD");
  const confidence = verdict === "HOLD" ? Math.round(Math.abs(score - 50) * 1.3) : Math.round(clamp(Math.abs(score - 50) * 2, 55, 95));
  const suggestedExposurePercent = verdict === "BUY"
    ? Math.round(clamp(10 + ((score - 60) * 0.75) - (volatilityPercent * 1.5), 8, 25))
    : 0;

  const explanation = verdict === "BUY"
    ? `Buy agreement: short and hourly trends are positive, momentum is confirmed and the wider US-market regime is supportive. Composite score ${score}/100.`
    : verdict === "SELL"
      ? `Sell protection: momentum and trend evidence weakened below the exit threshold. Composite score ${score}/100.`
      : `Hold: the independent signals did not agree strongly enough to justify ${held ? "an exit" : "risking capital"}. Composite score ${score}/100.`;

  return {
    score,
    confidence,
    verdict,
    referencePrice: price,
    volatilityPercent: Number(volatilityPercent.toFixed(3)),
    suggestedExposurePercent,
    signals: {
      fastTrendPercent: Number(fastTrend.toFixed(3)),
      hourlyTrendPercent: Number(slowTrend.toFixed(3)),
      marketRegimePercent: Number(benchmarkTrend.toFixed(3)),
      rsi: Number(currentRsi.toFixed(2)),
      macdHistogram: Number(macd.toFixed(4)),
      breakoutPercent: Number(breakoutPercent.toFixed(3)),
      volumeRatio: Number(volumeRatio.toFixed(2)),
      impulsePercent: Number(impulse.toFixed(3)),
      riskOff
    },
    explanation
  };
}
