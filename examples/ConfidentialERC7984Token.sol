// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ─────────────────────────────────────────────────────────────────────────────
// FHEVM AGENT PATTERN: ConfidentialERC7984Token
// ─────────────────────────────────────────────────────────────────────────────
// PURPOSE (for AI agents):
//   This contract demonstrates the minimal ERC-7984 confidential token pattern
//   using fhevm-contracts' ConfidentialERC20 base.
//
//   WHY ERC-7984?
//   Standard ERC-20 exposes ALL balances and transfer amounts on-chain.
//   Anyone can trace wallet holdings and transaction history.
//   ERC-7984 (Confidential Token Standard) keeps balances and amounts encrypted:
//     - balances[user] is a euint64 ciphertext handle — unreadable on-chain
//     - transfer amounts are submitted encrypted with ZK proofs
//     - only the token holder (+ explicitly granted addresses) can decrypt their balance
//     - the total supply remains plaintext (auditable) — balances stay private
//
//   This is the correct foundation for: payroll tokens, private DeFi, sealed bids,
//   confidential voting weights, and any financial privacy application.
//
// WHAT THIS EXAMPLE DEMONSTRATES:
//   1. Inheriting ConfidentialERC20 — the ACL + encrypted balance base
//   2. Minting initial supply as encrypted balances
//   3. Owner-only mint with correct ACL grants
//   4. Why the base handles transfer logic (don't re-implement it)
//
// AGENT RULE COVERAGE: RULE-02, RULE-03, RULE-04, RULE-08, RULE-10
// ─────────────────────────────────────────────────────────────────────────────

import "fhevm/lib/TFHE.sol";
// ConfidentialERC20 from fhevm-contracts:
//   - Stores balances as mapping(address => euint64)
//   - Implements encrypted transfer/transferFrom with input proof validation
//   - Manages ACL grants on every balance update automatically
//   - Exposes balanceOf(addr) handles for authorized off-chain decryption
import { ConfidentialERC20 } from "fhevm-contracts/contracts/token/ERC20/ConfidentialERC20.sol";

// Ownable from OpenZeppelin for minimal access control on mint.
import { Ownable2Step, Ownable } from "@openzeppelin/contracts/access/Ownable2Step.sol";

contract ConfidentialERC7984Token is ConfidentialERC20, Ownable2Step {
    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    /// @param name_   Token name (plaintext — token identity is public)
    /// @param symbol_ Token symbol (plaintext — same reason)
    /// @param initialSupply Amount to mint to deployer at launch (plaintext uint64)
    ///
    /// AGENT NOTE: The constructor accepts a PLAINTEXT supply amount because we
    /// are minting the initial float at deploy time — no user input proof needed.
    /// Post-deployment mints from users would require externalEuint64 + inputProof.
    constructor(
        string memory name_,
        string memory symbol_,
        uint64 initialSupply
    )
        ConfidentialERC20(name_, symbol_)
        Ownable(msg.sender)
    {
        // Mint initial supply to deployer.
        // _unsafeMint: ConfidentialERC20 internal mint for plaintext amounts.
        // It encrypts the value and sets up the balance handle internally.
        // "Unsafe" refers to the lack of overflow checking — acceptable here
        // since this is a controlled constructor mint.
        if (initialSupply > 0) {
            _unsafeMint(msg.sender, initialSupply);

            // AGENT RULE-03: ConfidentialERC20._unsafeMint sets up allowThis,
            // but we must explicitly allow the recipient to decrypt their own balance.
            // The base may or may not do this depending on version — always be explicit.
            TFHE.allow(_balances[msg.sender], msg.sender);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PATTERN: Owner Mint (Plaintext Amount → Encrypted Balance)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Mint tokens to a recipient. Owner only.
    /// @param to     Recipient address.
    /// @param amount Plaintext token amount to mint.
    ///
    /// AGENT PATTERN — Internal Plaintext-to-Encrypted Mint:
    ///   When the minter is the contract owner (trusted), a plaintext amount is
    ///   acceptable — no ZK proof required because there is no user-supplied
    ///   ciphertext. The contract wraps it into an encrypted handle internally.
    ///
    ///   CONTRAST with user-facing transfer:
    ///   User transfers use externalEuint64 + inputProof because the amount
    ///   comes from an untrusted external party.
    function mint(address to, uint64 amount) external onlyOwner {
        require(to != address(0), "Invalid recipient");
        require(amount > 0, "Amount must be > 0");

        _unsafeMint(to, amount);

        // Grant the recipient permission to decrypt their updated balance.
        // Without this, the recipient cannot use the relayer SDK to read their balance.
        TFHE.allow(_balances[to], to);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PATTERN: Transfer — Delegated to Base (Do NOT Re-implement)
    // ─────────────────────────────────────────────────────────────────────────

    // The ConfidentialERC20 base handles:
    //   - transfer(to, externalEuint64 encAmount, bytes inputProof)
    //   - transferFrom(from, to, externalEuint64 encAmount, bytes inputProof)
    //   - approve(spender, externalEuint64 encAmount, bytes inputProof)
    //
    // These functions:
    //   1. Call FHE.fromExternal(encAmount, inputProof) — validates user input
    //   2. Perform encrypted sub/add on sender/receiver balances
    //   3. Re-grant ACL on both updated handles
    //   4. Emit Transfer(from, to) — WITHOUT amounts (amounts stay encrypted)
    //
    // AGENT RULE: Do NOT re-implement transfer logic. The base already enforces
    // all FHEVM patterns correctly. Overriding without expertise is a common
    // source of ACL bugs and plaintext leakage.

    // ─────────────────────────────────────────────────────────────────────────
    // PATTERN: Balance Handle Exposure for Off-Chain Decryption
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Returns the caller's encrypted balance handle.
    ///         Use relayer SDK userDecrypt() off-chain to get the actual value.
    ///
    /// AGENT PATTERN — User reads their own balance:
    ///   On-chain: this function returns a euint64 handle (NOT plaintext).
    ///   Off-chain: relayerClient.userDecrypt({ handle, signer, contractAddress, chainId })
    ///   The relayer verifies the EIP-712 signature and decrypts under the user's key.
    ///   The plaintext never appears on-chain or in transaction data.
    function getMyBalanceHandle() external view returns (euint64) {
        euint64 handle = _balances[msg.sender];

        // Guard: only return if caller has ACL permission on this handle.
        // If the caller never received tokens, their handle may be uninitialized (handle == 0).
        require(
            euint64.unwrap(handle) != 0 && TFHE.isAllowed(handle, msg.sender),
            "No balance or not authorized"
        );

        return handle;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PATTERN: Total Supply — Public (intentionally plaintext)
    // ─────────────────────────────────────────────────────────────────────────

    // totalSupply() is inherited from ConfidentialERC20 and returns a plaintext uint64.
    // This is a deliberate ERC-7984 design choice:
    //   - Total supply is auditable (regulatory/trust requirement)
    //   - Individual balances remain encrypted (privacy requirement)
    // Agents should understand this asymmetry: supply = public, balances = private.
}
