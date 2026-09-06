use starknet::ContractAddress;

/// Test-only ERC20 whose `balance_of` calls back into the anonymizer.
///
/// This exists to prove the reentrancy guard is load-bearing rather than
/// decorative. `token` is caller-supplied and the anonymizer calls
/// `balance_of` on it *before* writing any high-water mark, so without the
/// guard a nested call sees every mark still at zero and can replay the very
/// vouchers the outer call is in the middle of settling.
#[starknet::interface]
pub trait IReenter<T> {
    fn set_target(ref self: T, target: ContractAddress, calldata: Array<felt252>);
}

#[starknet::contract]
pub mod MaliciousErc20 {
    use core::array::ArrayTrait;
    use starknet::storage::{
        StoragePointerReadAccess, StoragePointerWriteAccess, Vec, VecTrait, MutableVecTrait,
    };
    use starknet::syscalls::call_contract_syscall;
    use starknet::{ContractAddress, SyscallResultTrait};

    #[storage]
    struct Storage {
        target: ContractAddress,
        selector: felt252,
        calldata: Vec<felt252>,
        armed: bool,
    }

    #[abi(embed_v0)]
    impl ReenterImpl of super::IReenter<ContractState> {
        fn set_target(
            ref self: ContractState, target: ContractAddress, calldata: Array<felt252>,
        ) {
            self.target.write(target);
            self.selector.write(selector!("privacy_invoke"));
            for v in calldata {
                self.calldata.push(v);
            }
            self.armed.write(true);
        }
    }

    #[abi(per_item)]
    #[generate_trait]
    impl Erc20Like of Erc20LikeTrait {
        /// Reenters once, then behaves like a token reporting a balance.
        #[external(v0)]
        fn balance_of(ref self: ContractState, account: ContractAddress) -> u256 {
            if self.armed.read() {
                self.armed.write(false); // reenter once, not forever
                let mut args: Array<felt252> = ArrayTrait::new();
                for i in 0..self.calldata.len() {
                    args.append(self.calldata.at(i).read());
                }
                // Unwrapped on purpose: the guard's panic must propagate, so
                // the test sees REENTRANT_CALL rather than a swallowed error.
                call_contract_syscall(self.target.read(), self.selector.read(), args.span())
                    .unwrap_syscall();
            }
            1000_u256
        }

        #[external(v0)]
        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool {
            true
        }
    }
}
