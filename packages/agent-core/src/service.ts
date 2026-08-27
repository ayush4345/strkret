/**
 * A metered service a provider agent sells per call. The provider prices and
 * performs the work; the consumer pays for what it used once, at session
 * close, over one private STRK20 transfer — the amount and the per-unit rate
 * never appear on-chain, only the pool's shielded note does.
 */
export interface Service<Req, Res> {
  readonly name: string;
  /** Price of one request, in the token's smallest unit. Must be > 0. */
  price(req: Req): bigint;
  handle(req: Req): Promise<Res>;
}
