use privacy::objects::OpenNoteDeposit;
use starknet::ContractAddress;

pub mod mock_erc20;

/// DRAFT — unreviewed. Verifies a consumer-signed usage voucher and splits
/// an escrowed deposit into (settlement -> provider, refund -> consumer) in
/// one atomic STRK20 private transaction, so the settlement amount is
/// enforced on-chain rather than trusted. See the README's "Security review
/// needed" section before any deploy — the signature check in particular
/// must be independently reviewed: a bug there lets anyone forge a
/// settlement.
#[starknet::interface]
pub trait IMeteringAnonymizer<T> {
    /// Called by the STRK20 privacy pool via `INVOKE_SELECTOR`. `token` must
    /// already have been withdrawn to this contract by the pool — the
    /// escrowed amount is measured from this contract's own balance, never
    /// trusted as a calldata argument.
    ///
    /// - `rate`, `rate_blind`: private witnesses. Must hash to
    ///   `rate_commitment` (published off-chain, at channel open).
    /// - `channel_id`, `total_units`: the metered session's identity and the
    ///   consumer-authorized usage count. `total_units` is CUMULATIVE for the
    ///   channel, not per-settlement — vouchers are incremental, each
    ///   superseding the last, so a provider can hold an enforceable claim
    ///   for everything served so far without touching the chain. Only the
    ///   units not already settled on this channel get paid out here.
    /// - `consumer_pubkey`, `sig_r`, `sig_s`: the consumer's STARK-curve
    ///   signature over `poseidon(channel_id, total_units)` — proof the
    ///   consumer, not the provider or anyone else, authorized paying for
    ///   exactly `total_units`.
    /// - `provider_note_id`, `refund_note_id`: open notes the pool should
    ///   credit (computed client-side by the SDK, passed through calldata).
    fn privacy_invoke(
        ref self: T,
        token: ContractAddress,
        rate: u128,
        rate_blind: felt252,
        rate_commitment: felt252,
        channel_id: felt252,
        total_units: u128,
        consumer_pubkey: felt252,
        sig_r: felt252,
        sig_s: felt252,
        provider_note_id: felt252,
        refund_note_id: felt252,
    ) -> Span<OpenNoteDeposit>;
}

pub mod errors {
    pub const ZERO_TOKEN: felt252 = 'ZERO_TOKEN';
    pub const ZERO_RATE: felt252 = 'ZERO_RATE';
    pub const ZERO_UNITS: felt252 = 'ZERO_UNITS';
    pub const ZERO_ESCROW: felt252 = 'ZERO_ESCROW';
    pub const BAD_RATE_COMMITMENT: felt252 = 'BAD_RATE_COMMITMENT';
    pub const BAD_SIGNATURE: felt252 = 'BAD_SIGNATURE';
    pub const VOUCHER_ALREADY_USED: felt252 = 'VOUCHER_ALREADY_USED';
    pub const SETTLEMENT_EXCEEDS_ESCROW: felt252 = 'SETTLEMENT_EXCEEDS_ESCROW';
}

#[starknet::contract]
pub mod MeteringAnonymizer {
    use core::array::ArrayTrait;
    use core::ecdsa::check_ecdsa_signature;
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use privacy::objects::OpenNoteDeposit;
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use super::{IMeteringAnonymizer, errors};

    #[storage]
    struct Storage {
        /// Per-channel high-water mark: the highest `total_units` already
        /// settled on that channel. A voucher is spendable only if it is
        /// strictly newer, which subsumes plain replay (an identical voucher
        /// is no longer greater) while also blocking the subtler attack that
        /// incremental vouchers open up — settling a stale, smaller voucher
        /// from the same channel against a fresh escrow deposit after a
        /// larger one has already been paid.
        ///
        /// This is the one piece of state this contract keeps; it never
        /// holds funds across transactions (everything received is routed
        /// out in the same call), so the stateless-helper "stay
        /// permissionless" guidance still applies — no pool address needs
        /// pinning here.
        settled_units: Map<felt252, u128>,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl MeteringAnonymizerImpl of IMeteringAnonymizer<ContractState> {
        fn privacy_invoke(
            ref self: ContractState,
            token: ContractAddress,
            rate: u128,
            rate_blind: felt252,
            rate_commitment: felt252,
            channel_id: felt252,
            total_units: u128,
            consumer_pubkey: felt252,
            sig_r: felt252,
            sig_s: felt252,
            provider_note_id: felt252,
            refund_note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            assert(token.is_non_zero(), errors::ZERO_TOKEN);
            assert(rate.is_non_zero(), errors::ZERO_RATE);
            assert(total_units.is_non_zero(), errors::ZERO_UNITS);

            // The rate itself never appears in this function's success path
            // on its own — only bound into a commitment check. Only the
            // commitment (already public, from channel-open) and the
            // resulting settlement amount become visible here.
            let computed_commitment = poseidon_hash_span([rate.into(), rate_blind].span());
            assert(computed_commitment == rate_commitment, errors::BAD_RATE_COMMITMENT);

            // The consumer's own signature over (channel_id, total_units) is
            // the only thing that authorizes this settlement — not a
            // provider claim, not this contract's own judgement.
            let message_hash = poseidon_hash_span([channel_id, total_units.into()].span());
            let valid = check_ecdsa_signature(
                message_hash, consumer_pubkey, sig_r, sig_s,
            );
            assert(valid, errors::BAD_SIGNATURE);

            // Only the units beyond what this channel has already settled
            // are payable. The strict `>` both rejects replays and keeps the
            // subtraction below from underflowing.
            let already_settled = self.settled_units.read(channel_id);
            assert(total_units > already_settled, errors::VOUCHER_ALREADY_USED);
            self.settled_units.write(channel_id, total_units);

            // Escrow was already sent to us by the pool before this call —
            // read it from our own balance rather than trust a calldata
            // argument for it (the balance-delta idiom, applied to input
            // instead of external-call output since there's no external
            // call here).
            let token_dispatcher = IERC20Dispatcher { contract_address: token };
            let escrow_amount: u128 = token_dispatcher
                .balance_of(get_contract_address())
                .try_into()
                .unwrap();
            assert(escrow_amount.is_non_zero(), errors::ZERO_ESCROW);

            let settlement: u128 = (total_units - already_settled) * rate; // panics on overflow
            assert(settlement <= escrow_amount, errors::SETTLEMENT_EXCEEDS_ESCROW);

            let pool = get_caller_address();
            token_dispatcher.approve(spender: pool, amount: escrow_amount.into());

            let mut deposits: Array<OpenNoteDeposit> = ArrayTrait::new();
            deposits
                .append(
                    OpenNoteDeposit { note_id: provider_note_id, token, amount: settlement },
                );
            let refund = escrow_amount - settlement;
            if refund.is_non_zero() {
                deposits
                    .append(
                        OpenNoteDeposit { note_id: refund_note_id, token, amount: refund },
                    );
            }
            deposits.span()
        }
    }
}
