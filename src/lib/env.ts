// Typed env access. Defaults are the safe (simulation) configuration.

export type Config = {
  // Polymarket live trading (only read when SIMULATION_MODE=false AND --prod)
  PRIVATE_KEY: string;
  POLY_FUNDER_ADDRESS: string;
  BUILDER_KEY: string;
  BUILDER_SECRET: string;
  BUILDER_PASSPHRASE: string;

  // Speech-to-text
  DEEPGRAM_API_KEY: string;

  // Safety / risk
  SIMULATION_MODE: boolean;
  MAX_POSITION_PCT: number;
  DAILY_LOSS_LIMIT: number;
  MENTIONS_MAX_MARKET_USD: number;
  MENTIONS_MAX_EVENT_USD: number;
  MENTIONS_KELLY_FRACTION: number;
  MENTIONS_MIN_EDGE: number;
  MENTIONS_SNIPE_MAX_PRICE: number;

  // Sim realism (all default 0 / disabled)
  SIM_PARTIAL_FILL_PROB: number;
  SIM_SLIPPAGE_BPS: number;
  SIM_FEE_BPS: number;
  SIM_NETWORK_FAIL_PROB: number;
  SIM_LATENCY_JITTER_MS: number;
};

export class Env {
  private static readonly defaults: Config = {
    PRIVATE_KEY: "",
    POLY_FUNDER_ADDRESS: "",
    BUILDER_KEY: "",
    BUILDER_SECRET: "",
    BUILDER_PASSPHRASE: "",

    DEEPGRAM_API_KEY: "",

    // Live trading requires both SIMULATION_MODE=false AND the --prod flag.
    SIMULATION_MODE: true,
    MAX_POSITION_PCT: 0.05,
    DAILY_LOSS_LIMIT: 0,
    MENTIONS_MAX_MARKET_USD: 25,
    MENTIONS_MAX_EVENT_USD: 100,
    MENTIONS_KELLY_FRACTION: 0.25,
    MENTIONS_MIN_EDGE: 0.03,
    MENTIONS_SNIPE_MAX_PRICE: 0.95,

    SIM_PARTIAL_FILL_PROB: 0,
    SIM_SLIPPAGE_BPS: 0,
    SIM_FEE_BPS: 0,
    SIM_NETWORK_FAIL_PROB: 0,
    SIM_LATENCY_JITTER_MS: 0,
  };

  static get<T extends keyof Config>(key: T): Config[T] {
    const raw = process.env[key];
    const def = this.defaults[key];
    if (raw === undefined) return def;
    if (typeof def === "boolean") return (raw === "true") as Config[T];
    if (typeof def === "number") {
      const n = parseFloat(raw);
      return (isNaN(n) ? def : n) as Config[T];
    }
    return raw as Config[T];
  }
}
