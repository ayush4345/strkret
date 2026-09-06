use privacy::objects::OpenNoteDeposit;
use starknet::ContractAddress;

pub mod malicious_erc20;
pub mod mock_erc20;

/// DRAFT — unreviewed. Verifies a consumer-signed usage voucher and splits
/// an escrowed deposit into (settlement -> provider, refund -> consumer) in
/// one atomic STRK20 private transaction, so the settlement amount is
/// enforced on-chain rather than trusted. See the README's "Security review
/// needed" section before any deploy — the signature check in particular
/// must be independently reviewed: a bug there lets anyone forge a
/// settlement.
/// One provider's claim against the escrow: the voucher, the rate it was
/// agreed at, and where to pay it. A settlement carries a span of these, so a
/// consumer that used several provider agents pays them all in one
/// `apply_actions` call rather than one call each.
///
/// That batching is the point. The pool charges a flat protocol fee per
/// settlement (6 STRK on mainnet), so paying M providers separately costs M
/// times the fee for the same work — with a batch it is paid once, and the
/// per-counterparty overhead falls as the batch grows.
#[derive(Copy, Drop, Serde)]
pub struct ProviderClaim {
    /// Private witnesses. Must hash to `rate_commitment`.
    pub rate: u128,
    pub rate_blind: felt252,
    /// Published off-chain at channel open.
    pub rate_commitment: felt252,
    /// The channel's identity and the consumer-authorized cumulative usage.
    pub channel_id: felt252,
    pub total_units: u128,
    /// Proof the consumer authorized paying for exactly `total_units`.
    pub consumer_pubkey: felt252,
    pub sig_r: felt252,
    pub sig_s: felt252,
    /// The open note the pool should credit this provider's settlement to.
    pub provider_note_id: felt252,
}

#[starknet::interface]
pub trait IMeteringAnonymizer<T> {
    /// Called by the STRK20 privacy pool via `INVOKE_SELECTOR`. `token` must
    /// already have been withdrawn to this contract by the pool — the
    /// escrowed amount is measured from this contract's own balance, never
    /// trusted as a calldata argument.
    ///
    /// - `claims`: one entry per provider being paid out of this escrow. Each
    ///   carries its own voucher, so every provider is paid only what its own
    ///   consumer signed for. `total_units` on each is CUMULATIVE for that
    ///   channel, not per-settlement — vouchers are incremental, each
    ///   superseding the last, so a provider holds an enforceable claim for
    ///   everything served without touching the chain, and only the units not
    ///   already settled on that channel get paid here.
    /// - `refund_note_id`: open note for whatever escrow the claims don't
    ///   consume. Both note ids are computed client-side by the SDK and passed
    ///   through calldata.
    ///
    /// Returns one deposit per claim, in claim order, plus a trailing refund
    /// deposit when the refund is non-zero — the caller relies on that order
    /// to match deposits back to the notes it declared.
    fn privacy_invoke(
        ref self: T,
        token: ContractAddress,
        claims: Span<ProviderClaim>,
        refund_note_id: felt252,
    ) -> Span<OpenNoteDeposit>;
}

pub mod errors {
    pub const ZERO_TOKEN: felt252 = 'ZERO_TOKEN';
    pub const ZERO_RATE: felt252 = 'ZERO_RATE';
    pub const ZERO_UNITS: felt252 = 'ZERO_UNITS';
    pub const NO_CLAIMS: felt252 = 'NO_CLAIMS';
    pub const ZERO_ESCROW: felt252 = 'ZERO_ESCROW';
    pub const BAD_RATE_COMMITMENT: felt252 = 'BAD_RATE_COMMITMENT';
    pub const BAD_SIGNATURE: felt252 = 'BAD_SIGNATURE';
    pub const VOUCHER_ALREADY_USED: felt252 = 'VOUCHER_ALREADY_USED';
    pub const SETTLEMENT_EXCEEDS_ESCROW: felt252 = 'SETTLEMENT_EXCEEDS_ESCROW';
    pub const ESCROW_TOO_LARGE: felt252 = 'ESCROW_TOO_LARGE';
}

#[starknet::contract]
pub mod MeteringAnonymizer {
    use core::array::ArrayTrait;
    use core::ecdsa::check_ecdsa_signature;
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use openzeppelin::security::reentrancyguard::ReentrancyGuardComponent;
    use privacy::objects::OpenNoteDeposit;
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use super::{IMeteringAnonymizer, ProviderClaim, errors};

    component!(
        path: ReentrancyGuardComponent, storage: reentrancy_guard, event: ReentrancyGuardEvent,
    );
    impl ReentrancyGuardInternal = ReentrancyGuardComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        reentrancy_guard: ReentrancyGuardComponent::Storage,
        /// Per-channel high-water mark: the highest `total_units` already
        /// settled on that channel, keyed by
        /// `poseidon(consumer_pubkey, channel_id)` so that channels are
        /// isolated per consumer rather than shared across everyone who
        /// picks the same caller-chosen `channel_id`. A voucher is spendable
        /// only if it is strictly newer, which subsumes plain replay (an
        /// identical voucher is no longer greater) while also blocking the
        /// subtler attack that incremental vouchers open up — settling a
        /// stale, smaller voucher from the same channel against a fresh
        /// escrow deposit after a larger one has already been paid.
        ///
        /// This is the one piece of state this contract keeps; it never
        /// holds funds across transactions (everything received is routed
        /// out in the same call), so the stateless-helper "stay
        /// permissionless" guidance still applies — no pool address needs
        /// pinning here.
        settled_units: Map<felt252, u128>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ReentrancyGuardEvent: ReentrancyGuardComponent::Event,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl MeteringAnonymizerImpl of IMeteringAnonymizer<ContractState> {
        fn privacy_invoke(
            ref self: ContractState,
            token: ContractAddress,
            claims: Span<ProviderClaim>,
            refund_note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            // `token` is caller-supplied and this function makes external
            // calls to it (`balance_of`, `approve`) *before* the high-water
            // marks are written. Without a guard, a malicious token can
            // reenter from `balance_of` while every mark still reads zero and
            // replay the same vouchers — each nested call passing the
            // strictly-newer check because the outer one has not recorded
            // anything yet.
            self.reentrancy_guard.start();

            assert(token.is_non_zero(), errors::ZERO_TOKEN);
            assert(claims.len().is_non_zero(), errors::NO_CLAIMS);

            // Escrow was already sent to us by the pool before this call —
            // read it from our own balance rather than trust a calldata
            // argument for it (the balance-delta idiom, applied to input
            // instead of external-call output since there's no external
            // call here).
            let token_dispatcher = IERC20Dispatcher { contract_address: token };
            // A bare `unwrap()` here panics with no indication of why. Above
            // u128::MAX is not a reachable balance for any real token, but a
            // named error beats an unexplained failure in a settlement path.
            let escrow_u256 = token_dispatcher.balance_of(get_contract_address());
            let escrow_maybe: Option<u128> = escrow_u256.try_into();
            let escrow_amount: u128 = escrow_maybe.expect(errors::ESCROW_TOO_LARGE);
            assert(escrow_amount.is_non_zero(), errors::ZERO_ESCROW);

            let mut deposits: Array<OpenNoteDeposit> = ArrayTrait::new();
            let mut total_settlement: u128 = 0;
            let mut i: u32 = 0;

            while i != claims.len() {
                let claim = *claims.at(i);
                assert(claim.rate.is_non_zero(), errors::ZERO_RATE);
                assert(claim.total_units.is_non_zero(), errors::ZERO_UNITS);

                // The rate itself never appears in this function's success
                // path on its own — only bound into a commitment check. Only
                // the commitment (already public, from channel-open) and the
                // resulting settlement amount become visible here.
                let computed_commitment = poseidon_hash_span(
                    [claim.rate.into(), claim.rate_blind].span(),
                );
                assert(computed_commitment == claim.rate_commitment, errors::BAD_RATE_COMMITMENT);

                // The consumer's own signature is the only thing that
                // authorizes this settlement — not a provider claim, not this
                // contract's own judgement. Each claim carries its own, so one
                // consumer's signature can never authorize a payout to a
                // provider it did not agree with.
                //
                // `rate_commitment` is inside the signed message, and that is
                // what makes the amount enforceable. The commitment check
                // above only proves `rate` opens `rate_commitment`; both
                // arrive in the same calldata, so on its own it proves the
                // caller can hash two numbers it chose. Binding the commitment
                // into the signature is what pins the settlement to a rate the
                // consumer actually agreed to — without it, whoever builds the
                // transaction picks the payout, and a consumer could settle a
                // 100-unit voucher at rate 1 instead of the agreed 5.
                let message_hash = poseidon_hash_span(
                    [claim.channel_id, claim.total_units.into(), claim.rate_commitment].span(),
                );
                let valid = check_ecdsa_signature(
                    message_hash, claim.consumer_pubkey, claim.sig_r, claim.sig_s,
                );
                assert(valid, errors::BAD_SIGNATURE);

                // Only the units beyond what this channel has already settled
                // are payable. The strict `>` both rejects replays and keeps
                // the subtraction below from underflowing.
                //
                // The mark is keyed by (consumer_pubkey, channel_id), not
                // channel_id alone: `channel_id` is caller-chosen and carries
                // no identity of its own, so keying on it alone would let two
                // consumers who happened to pick the same value share a mark
                // and cap or block each other's settlements.
                //
                // Written inside the loop rather than after it, so a batch
                // that lists the same channel twice sees its own first entry
                // as already settled and pays the second only the remaining
                // delta — a duplicate cannot be used to pay twice.
                let channel_key = poseidon_hash_span(
                    [claim.consumer_pubkey, claim.channel_id].span(),
                );
                let already_settled = self.settled_units.read(channel_key);
                assert(claim.total_units > already_settled, errors::VOUCHER_ALREADY_USED);
                self.settled_units.write(channel_key, claim.total_units);

                let settlement: u128 = (claim.total_units - already_settled)
                    * claim.rate; // panics on overflow
                total_settlement += settlement; // panics on overflow

                deposits
                    .append(
                        OpenNoteDeposit {
                            note_id: claim.provider_note_id, token, amount: settlement,
                        },
                    );
                i += 1;
            };

            // Checked once against the whole batch: individually affordable
            // claims can still exceed the escrow together.
            assert(total_settlement <= escrow_amount, errors::SETTLEMENT_EXCEEDS_ESCROW);

            let pool = get_caller_address();
            token_dispatcher.approve(spender: pool, amount: escrow_amount.into());

            let refund = escrow_amount - total_settlement;
            if refund.is_non_zero() {
                deposits.append(OpenNoteDeposit { note_id: refund_note_id, token, amount: refund });
            }

            self.reentrancy_guard.end();
            deposits.span()
        }
    }
}
