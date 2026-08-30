use metering_anonymizer::{IMeteringAnonymizerDispatcher, IMeteringAnonymizerDispatcherTrait};
use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address};
use starknet::ContractAddress;

// Test vector generated with starknet.js (the same library our real client
// uses to sign) for private_key = 0x1: sign(poseidon(channel_id=1,
// total_units=100)) and poseidon(rate=5, rate_blind=42). Not a placeholder —
// this is the actual signature the on-chain check has to accept.
const CONSUMER_PUBKEY: felt252 = 0x1ef15c18599971b7beced415a40f0c7deacfd9b0d1819e03d723d8bc943cfca;
const CHANNEL_ID: felt252 = 1;
const TOTAL_UNITS: u128 = 100;
const SIG_R: felt252 = 0x4a2160061438583b5b5724a348dff7b051fbf30f0d75c355eff59f3c552dbf8;
const SIG_S: felt252 = 0x4d0621ee782b395424644c4c9bd3699d8768f2a8ecf5a893adf5243eced5c68;
const RATE: u128 = 5;
const RATE_BLIND: felt252 = 42;
const RATE_COMMITMENT: felt252 = 0x6543d1c88b2dbfa68234938d4b8fb03ade9966495f58a3db6eca8f47583e0a8;
const ESCROW_AMOUNT: u256 = 1000;
const EXPECTED_SETTLEMENT: u128 = 500; // RATE * TOTAL_UNITS
const PROVIDER_NOTE_ID: felt252 = 111;
const REFUND_NOTE_ID: felt252 = 222;

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
        .privacy_invoke(
            token,
            RATE,
            RATE_BLIND,
            RATE_COMMITMENT,
            CHANNEL_ID,
            TOTAL_UNITS,
            CONSUMER_PUBKEY,
            SIG_R,
            SIG_S,
            PROVIDER_NOTE_ID,
            REFUND_NOTE_ID,
        );

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
        .privacy_invoke(
            token, RATE, RATE_BLIND, RATE_COMMITMENT, CHANNEL_ID, 200_u128,
            CONSUMER_PUBKEY, SIG_R, SIG_S, PROVIDER_NOTE_ID, REFUND_NOTE_ID,
        );
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
            token, 6_u128, RATE_BLIND, RATE_COMMITMENT, CHANNEL_ID, TOTAL_UNITS,
            CONSUMER_PUBKEY, SIG_R, SIG_S, PROVIDER_NOTE_ID, REFUND_NOTE_ID,
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
        .privacy_invoke(
            token, RATE, RATE_BLIND, RATE_COMMITMENT, CHANNEL_ID, TOTAL_UNITS,
            CONSUMER_PUBKEY, SIG_R, SIG_S, PROVIDER_NOTE_ID, REFUND_NOTE_ID,
        );
    dispatcher
        .privacy_invoke(
            token, RATE, RATE_BLIND, RATE_COMMITMENT, CHANNEL_ID, TOTAL_UNITS,
            CONSUMER_PUBKEY, SIG_R, SIG_S, PROVIDER_NOTE_ID, REFUND_NOTE_ID,
        );
}

#[test]
#[should_panic(expected: 'SETTLEMENT_EXCEEDS_ESCROW')]
fn rejects_settlement_above_escrow() {
    let anonymizer = deploy_anonymizer();
    // Only fund 100 — far less than the 500 this voucher settles for.
    let token = deploy_mock_erc20(anonymizer, 100);
    start_cheat_caller_address(anonymizer, 0x999.try_into().unwrap());

    IMeteringAnonymizerDispatcher { contract_address: anonymizer }
        .privacy_invoke(
            token, RATE, RATE_BLIND, RATE_COMMITMENT, CHANNEL_ID, TOTAL_UNITS,
            CONSUMER_PUBKEY, SIG_R, SIG_S, PROVIDER_NOTE_ID, REFUND_NOTE_ID,
        );
}
