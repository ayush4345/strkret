/// Test-only ERC20, mints the full supply to `recipient` at construction.
/// Not part of the anonymizer's production surface — exists so the test
/// suite can fund the contract under test without depending on a real
/// token deployment.
#[starknet::contract]
pub mod MockErc20 {
    use openzeppelin::token::erc20::ERC20Component;
    use starknet::ContractAddress;

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);

    #[abi(embed_v0)]
    impl ERC20Impl = ERC20Component::ERC20Impl<ContractState>;
    impl ERC20InternalImpl = ERC20Component::InternalImpl<ContractState>;

    impl ERC20HooksEmptyImpl of ERC20Component::ERC20HooksTrait<ContractState> {}

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ERC20Event: ERC20Component::Event,
    }

    #[constructor]
    fn constructor(ref self: ContractState, recipient: ContractAddress, amount: u256) {
        self.erc20.initializer("Mock", "MOCK");
        self.erc20.mint(recipient, amount);
    }
}
