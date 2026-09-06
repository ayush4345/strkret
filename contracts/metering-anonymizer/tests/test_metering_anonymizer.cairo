use metering_anonymizer::{
    IMeteringAnonymizerDispatcher, IMeteringAnonymizerDispatcherTrait, ProviderClaim,
};
use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address};
use core::poseidon::poseidon_hash_span;
use starknet::ContractAddress;

// Test vectors generated with starknet.js (the same library our real client
// uses to sign) for private_key = 0x1: sign(poseidon(channel_id, total_units,
// rate_commitment)) where rate_commitment = poseidon(rate=5, rate_blind=42).
// Not placeholders — these are the actual signatures the on-chain check has
// to accept, and the commitment is inside the signed message because that is
// what pins the settlement to an agreed rate.
const CONSUMER_PUBKEY: felt252 = 0x1ef15c18599971b7beced415a40f0c7deacfd9b0d1819e03d723d8bc943cfca;
const CHANNEL_ID: felt252 = 1;
const TOTAL_UNITS: u128 = 100;
const SIG_R: felt252 = 0x5c18b457290b1339d9152a7156896fcc471f3aa368e4f50373d83d6b7d7e751;
const SIG_S: felt252 = 0x2580bf2c846990dee97737d7384f3df85315b9640161d02c06acc26c20e2c4f;
// A second, strictly newer voucher on the SAME channel — sign(poseidon(
// channel_id=1, total_units=150)) for the same private_key = 0x1. Same
// provenance as the vector above, generated with starknet.js.
const TOTAL_UNITS_2: u128 = 150;
const SIG_R_2: felt252 = 0x49c0ff094530ab99282215f52d6b3494183437ce7c2afa86c1973c3206d36fb;
const SIG_S_2: felt252 = 0x5f31872edc94f408a73a8ba036479110f7a6c33f4bebbcccc0e5f14358d86a;
// A DIFFERENT consumer (private_key = 0x2) signing the SAME channel_id and
// unit count, for the channel-isolation test below.
const CONSUMER_2_PUBKEY: felt252 = 0x759ca09377679ecd535a81e83039658bf40959283187c654c5416f439403cf5;
const CONSUMER_2_SIG_R: felt252 = 0x404915cdf053166a9e7e60469181e7c9dfcd91a7439fe22d9b0b7b4a2cc27dc;
const CONSUMER_2_SIG_S: felt252 = 0x177728d5b06dc1ac576a10a3c316d15d8a538f862edf34fb446e06b402736ee;
const RATE: u128 = 5;
const RATE_BLIND: felt252 = 42;
const RATE_COMMITMENT: felt252 = 0x6543d1c88b2dbfa68234938d4b8fb03ade9966495f58a3db6eca8f47583e0a8;
const ESCROW_AMOUNT: u256 = 1000;
const EXPECTED_SETTLEMENT: u128 = 500; // RATE * TOTAL_UNITS
const PROVIDER_NOTE_ID: felt252 = 111;
const PROVIDER_2_NOTE_ID: felt252 = 333;
const REFUND_NOTE_ID: felt252 = 222;

// A second consumer paying a second provider, on its own channel — the batch
// case. sign(poseidon(channel_id=2, total_units=100)) for private_key = 0x2.
const C2_CHANNEL: felt252 = 2;
const C2_UNITS: u128 = 100;
const C2_PUBKEY: felt252 = 0x759ca09377679ecd535a81e83039658bf40959283187c654c5416f439403cf5;
const C2_SIG_R: felt252 = 0x201f69f7ae90a178d0dcaf4c2a72d1022f82b0fe350eb2337a0fca6c8a09f56;
const C2_SIG_S: felt252 = 0x175fecfac0c1a3dc05135387b2747249e0c3e278d148a4471d272bea2194650;

/// Assemble one claim at the shared rate. Every test builds claims through
/// this, so a signature and the units it covers cannot drift apart by hand.
fn claim(
    channel_id: felt252,
    total_units: u128,
    pubkey: felt252,
    sig_r: felt252,
    sig_s: felt252,
    note_id: felt252,
) -> ProviderClaim {
    ProviderClaim {
        rate: RATE,
        rate_blind: RATE_BLIND,
        rate_commitment: RATE_COMMITMENT,
        channel_id,
        total_units,
        consumer_pubkey: pubkey,
        sig_r,
        sig_s,
        provider_note_id: note_id,
    }
}

/// The single-consumer claim most tests use.
fn consumer_claim(total_units: u128, sig_r: felt252, sig_s: felt252) -> ProviderClaim {
    claim(CHANNEL_ID, total_units, CONSUMER_PUBKEY, sig_r, sig_s, PROVIDER_NOTE_ID)
}

fn deploy_mock_erc20(recipient: ContractAddress, amount: u256) -> ContractAddress {
    let contract = declare("MockErc20").unwrap().contract_class();
    let mut calldata = array![];
    recipient.serialize(ref calldata);
    amount.serialize(ref calldata);
    let (address, _) = contract.deploy(@calldata).unwrap();
    address
}

fn deploy_anonymizer() -> ContractAddress {
    let contract = declare("MeteringAnonymizer").unwrap().contract_class();
    let (address, _) = contract.deploy(@array![]).unwrap();
    address
}

#[test]
fn splits_settlement_and_refund_correctly() {
    let anonymizer = deploy_anonymizer();
    let token = deploy_mock_erc20(anonymizer, ESCROW_AMOUNT);

    let pool: ContractAddress = 0x999.try_into().unwrap();
    start_cheat_caller_address(anonymizer, pool);

    let deposits = IMeteringAnonymizerDispatcher { contract_address: anonymizer }
        .privacy_invoke(token, array![consumer_claim(TOTAL_UNITS, SIG_R, SIG_S)].span(), REFUND_NOTE_ID);

    assert(deposits.len() == 2, 'expected 2 deposits');
    let provider_deposit = *deposits.at(0);
    assert(provider_deposit.note_id == PROVIDER_NOTE_ID, 'wrong provider note');
    assert(provider_deposit.amount == EXPECTED_SETTLEMENT, 'wrong settlement amount');
    let refund_deposit = *deposits.at(1);
    assert(refund_deposit.note_id == REFUND_NOTE_ID, 'wrong refund note');
    assert(
        refund_deposit.amount == (ESCROW_AMOUNT - EXPECTED_SETTLEMENT.into()).try_into().unwrap(),
        'wrong refund amount',
    );

    // approve(pool, escrow_amount) must actually have been called.
    let allowance = IERC20Dispatcher { contract_address: token }.allowance(anonymizer, pool);
    assert(allowance == ESCROW_AMOUNT, 'pool not approved for escrow');
}

#[test]
#[should_panic(expected: 'BAD_SIGNATURE')]
fn rejects_tampered_total_units() {
    let anonymizer = deploy_anonymizer();
    let token = deploy_mock_erc20(anonymizer, ESCROW_AMOUNT);
    start_cheat_caller_address(anonymizer, 0x999.try_into().unwrap());

    // Same signature, but claiming 200 units instead of the 100 it was
    // actually signed for — must not verify.
    IMeteringAnonymizerDispatcher { contract_address: anonymizer }
        .privacy_invoke(token, array![consumer_claim(200_u128, SIG_R, SIG_S)].span(), REFUND_NOTE_ID);
}

#[test]
#[should_panic(expected: 'BAD_RATE_COMMITMENT')]
fn rejects_wrong_rate_for_commitment() {
    let anonymizer = deploy_anonymizer();
    let token = deploy_mock_erc20(anonymizer, ESCROW_AMOUNT);
    start_cheat_caller_address(anonymizer, 0x999.try_into().unwrap());

    // A different rate that doesn't hash to RATE_COMMITMENT.
    IMeteringAnonymizerDispatcher { contract_address: anonymizer }
        .privacy_invoke(
            token,
            array![
                ProviderClaim {
                    rate: 6_u128,
                    rate_blind: RATE_BLIND,
                    rate_commitment: RATE_COMMITMENT,
                    channel_id: CHANNEL_ID,
                    total_units: TOTAL_UNITS,
                    consumer_pubkey: CONSUMER_PUBKEY,
                    sig_r: SIG_R,
                    sig_s: SIG_S,
                    provider_note_id: PROVIDER_NOTE_ID,
                },
            ]
                .span(),
            REFUND_NOTE_ID,
        );
}

#[test]
#[should_panic(expected: 'VOUCHER_ALREADY_USED')]
fn rejects_replayed_voucher() {
    let anonymizer = deploy_anonymizer();
    // Fund enough for two invocations, so the second panics on replay, not
    // on insufficient balance.
    let token = deploy_mock_erc20(anonymizer, ESCROW_AMOUNT * 2);
    start_cheat_caller_address(anonymizer, 0x999.try_into().unwrap());

    let dispatcher = IMeteringAnonymizerDispatcher { contract_address: anonymizer };
    dispatcher
        .privacy_invoke(token, array![consumer_claim(TOTAL_UNITS, SIG_R, SIG_S)].span(), REFUND_NOTE_ID);
    dispatcher
        .privacy_invoke(token, array![consumer_claim(TOTAL_UNITS, SIG_R, SIG_S)].span(), REFUND_NOTE_ID);
}

/// Incremental vouchers: settling a newer voucher on a channel pays only
/// the units beyond the high-water mark, never the cumulative total again.
/// This is what lets a provider hold a running claim off-chain and settle
/// periodically without double-charging for units already paid.
#[test]
fn settles_only_the_delta_on_a_newer_voucher() {
    let anonymizer = deploy_anonymizer();
    let token = deploy_mock_erc20(anonymizer, ESCROW_AMOUNT * 2);
    start_cheat_caller_address(anonymizer, 0x999.try_into().unwrap());
    let dispatcher = IMeteringAnonymizerDispatcher { contract_address: anonymizer };

    let first = dispatcher
        .privacy_invoke(token, array![consumer_claim(TOTAL_UNITS, SIG_R, SIG_S)].span(), REFUND_NOTE_ID);
    assert(*first.at(0).amount == EXPECTED_SETTLEMENT, 'wrong first settlement');

    // 150 cumulative units against a mark of 100 — only the 50 new units
    // are payable, so 250, not the 750 a cumulative reading would give.
    let second = dispatcher
        .privacy_invoke(token, array![consumer_claim(TOTAL_UNITS_2, SIG_R_2, SIG_S_2)].span(), REFUND_NOTE_ID);
    assert(*second.at(0).amount == (TOTAL_UNITS_2 - TOTAL_UNITS) * RATE, 'wrong delta settlement');
}

/// `channel_id` is caller-chosen and carries no identity, so two consumers
/// can pick the same one. Their high-water marks must stay independent —
/// otherwise the first to settle would cap or block the second, who never
/// agreed to share a channel with them.
#[test]
fn channels_are_isolated_per_consumer() {
    let anonymizer = deploy_anonymizer();
    let token = deploy_mock_erc20(anonymizer, ESCROW_AMOUNT * 2);
    start_cheat_caller_address(anonymizer, 0x999.try_into().unwrap());
    let dispatcher = IMeteringAnonymizerDispatcher { contract_address: anonymizer };

    // Consumer 1 settles 100 units on channel 1, taking that mark to 100.
    dispatcher
        .privacy_invoke(token, array![consumer_claim(TOTAL_UNITS, SIG_R, SIG_S)].span(), REFUND_NOTE_ID);

    // Consumer 2's first voucher on the same channel id is also 100 units.
    // Keyed on channel_id alone this would be rejected as stale; keyed on
    // (pubkey, channel_id) it settles in full.
    let second = dispatcher
        .privacy_invoke(token, array![claim(CHANNEL_ID, TOTAL_UNITS, CONSUMER_2_PUBKEY, CONSUMER_2_SIG_R, CONSUMER_2_SIG_S, PROVIDER_NOTE_ID)].span(), REFUND_NOTE_ID);
    assert(*second.at(0).amount == EXPECTED_SETTLEMENT, 'consumer 2 was not isolated');
}

/// The attack incremental vouchers open up that a plain used-voucher set
/// would miss: after settling at 150, the older-but-still-validly-signed
/// 100-unit voucher must not be settleable against a fresh escrow.
#[test]
#[should_panic(expected: 'VOUCHER_ALREADY_USED')]
fn rejects_stale_voucher_after_a_newer_one_settled() {
    let anonymizer = deploy_anonymizer();
    let token = deploy_mock_erc20(anonymizer, ESCROW_AMOUNT * 2);
    start_cheat_caller_address(anonymizer, 0x999.try_into().unwrap());
    let dispatcher = IMeteringAnonymizerDispatcher { contract_address: anonymizer };

    dispatcher
        .privacy_invoke(token, array![consumer_claim(TOTAL_UNITS_2, SIG_R_2, SIG_S_2)].span(), REFUND_NOTE_ID);
    dispatcher
        .privacy_invoke(token, array![consumer_claim(TOTAL_UNITS, SIG_R, SIG_S)].span(), REFUND_NOTE_ID);
}

#[test]
#[should_panic(expected: 'SETTLEMENT_EXCEEDS_ESCROW')]
fn rejects_settlement_above_escrow() {
    let anonymizer = deploy_anonymizer();
    // Only fund 100 — far less than the 500 this voucher settles for.
    let token = deploy_mock_erc20(anonymizer, 100);
    start_cheat_caller_address(anonymizer, 0x999.try_into().unwrap());

    IMeteringAnonymizerDispatcher { contract_address: anonymizer }
        .privacy_invoke(token, array![consumer_claim(TOTAL_UNITS, SIG_R, SIG_S)].span(), REFUND_NOTE_ID);
}

/// The batching case the whole design exists for: two providers, two
/// consumers, one settlement — so the pool's flat protocol fee is paid once
/// instead of once per counterparty.
#[test]
fn settles_several_providers_in_one_call() {
    let anonymizer = deploy_anonymizer();
    let token = deploy_mock_erc20(anonymizer, ESCROW_AMOUNT * 2);
    start_cheat_caller_address(anonymizer, 0x999.try_into().unwrap());

    let deposits = IMeteringAnonymizerDispatcher { contract_address: anonymizer }
        .privacy_invoke(
            token,
            array![
                consumer_claim(TOTAL_UNITS, SIG_R, SIG_S),
                claim(C2_CHANNEL, C2_UNITS, C2_PUBKEY, C2_SIG_R, C2_SIG_S, PROVIDER_2_NOTE_ID),
            ]
                .span(),
            REFUND_NOTE_ID,
        );

    // One deposit per claim, in claim order, then the refund.
    assert(deposits.len() == 3, 'expected 3 deposits');
    assert(*deposits.at(0).note_id == PROVIDER_NOTE_ID, 'wrong provider 1 note');
    assert(*deposits.at(0).amount == EXPECTED_SETTLEMENT, 'wrong provider 1 amount');
    assert(*deposits.at(1).note_id == PROVIDER_2_NOTE_ID, 'wrong provider 2 note');
    assert(*deposits.at(1).amount == C2_UNITS * RATE, 'wrong provider 2 amount');
    assert(*deposits.at(2).note_id == REFUND_NOTE_ID, 'wrong refund note');
    assert(
        *deposits.at(2).amount == (ESCROW_AMOUNT * 2 - (EXPECTED_SETTLEMENT + C2_UNITS * RATE)
            .into())
            .try_into()
            .unwrap(),
        'wrong refund amount',
    );
}

/// A batch listing one channel twice must not pay it twice. The mark is
/// written inside the loop, so the second entry sees the first as already
/// settled and is rejected for not being strictly newer.
#[should_panic(expected: 'VOUCHER_ALREADY_USED')]
#[test]
fn rejects_a_channel_listed_twice_in_one_batch() {
    let anonymizer = deploy_anonymizer();
    let token = deploy_mock_erc20(anonymizer, ESCROW_AMOUNT * 2);
    start_cheat_caller_address(anonymizer, 0x999.try_into().unwrap());

    IMeteringAnonymizerDispatcher { contract_address: anonymizer }
        .privacy_invoke(
            token,
            array![
                consumer_claim(TOTAL_UNITS, SIG_R, SIG_S),
                consumer_claim(TOTAL_UNITS, SIG_R, SIG_S),
            ]
                .span(),
            REFUND_NOTE_ID,
        );
}

/// Claims that each fit inside the escrow can still exceed it together, so
/// the cap is checked against the batch total rather than per claim.
#[should_panic(expected: 'SETTLEMENT_EXCEEDS_ESCROW')]
#[test]
fn rejects_a_batch_that_exceeds_escrow_in_aggregate() {
    let anonymizer = deploy_anonymizer();
    // 600 covers either 500-unit claim alone, but not both.
    let token = deploy_mock_erc20(anonymizer, 600);
    start_cheat_caller_address(anonymizer, 0x999.try_into().unwrap());

    IMeteringAnonymizerDispatcher { contract_address: anonymizer }
        .privacy_invoke(
            token,
            array![
                consumer_claim(TOTAL_UNITS, SIG_R, SIG_S),
                claim(C2_CHANNEL, C2_UNITS, C2_PUBKEY, C2_SIG_R, C2_SIG_S, PROVIDER_2_NOTE_ID),
            ]
                .span(),
            REFUND_NOTE_ID,
        );
}

#[should_panic(expected: 'NO_CLAIMS')]
#[test]
fn rejects_an_empty_batch() {
    let anonymizer = deploy_anonymizer();
    let token = deploy_mock_erc20(anonymizer, ESCROW_AMOUNT);
    start_cheat_caller_address(anonymizer, 0x999.try_into().unwrap());

    IMeteringAnonymizerDispatcher { contract_address: anonymizer }
        .privacy_invoke(token, array![].span(), REFUND_NOTE_ID);
}

/// The reason the commitment is signed rather than merely passed. A voucher
/// is valid for the units it names *at the rate it was agreed at* — settling
/// it against a different commitment, even one that opens correctly, must
/// fail. Without this the settling party picks the payout: a 100-unit voucher
/// could be settled at rate 1 instead of the agreed 5.
#[should_panic(expected: 'BAD_SIGNATURE')]
#[test]
fn rejects_a_voucher_settled_at_a_different_rate() {
    let anonymizer = deploy_anonymizer();
    let token = deploy_mock_erc20(anonymizer, ESCROW_AMOUNT);
    start_cheat_caller_address(anonymizer, 0x999.try_into().unwrap());

    // rate 1 with a blind that opens its own commitment — internally
    // consistent, and signed by nobody.
    let cheap_commitment = poseidon_hash_span([1_u128.into(), RATE_BLIND].span());
    IMeteringAnonymizerDispatcher { contract_address: anonymizer }
        .privacy_invoke(
            token,
            array![
                ProviderClaim {
                    rate: 1_u128,
                    rate_blind: RATE_BLIND,
                    rate_commitment: cheap_commitment,
                    channel_id: CHANNEL_ID,
                    total_units: TOTAL_UNITS,
                    consumer_pubkey: CONSUMER_PUBKEY,
                    sig_r: SIG_R,
                    sig_s: SIG_S,
                    provider_note_id: PROVIDER_NOTE_ID,
                },
            ]
                .span(),
            REFUND_NOTE_ID,
        );
}
