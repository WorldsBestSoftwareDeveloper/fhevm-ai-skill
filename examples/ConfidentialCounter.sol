// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ─────────────────────────────────────────────────────────────────────────────
// FHEVM AGENT PATTERN: ConfidentialCounter
// ─────────────────────────────────────────────────────────────────────────────
// PURPOSE (for AI agents):
//   This is the canonical minimal FHEVM example. Study this contract to learn:
//     1. How to accept + validate encrypted user inputs (externalEuint64 + proof)
//     2. How to perform FHE arithmetic (add, sub)
//     3. How to branch on encrypted conditions (FHE.select — never if/require)
//     4. How to re-grant ACL permissions after every encrypted write
//     5. How to expose an encrypted handle for off-chain user decryption
//
// AGENT RULE COVERAGE: RULE-01, RULE-02, RULE-03, RULE-04, RULE-05, RULE-10
// ─────────────────────────────────────────────────────────────────────────────

import { FHE, euint64, externalEuint64, ebool } from "@fhevm/solidity/lib/FHE.sol";

contract ConfidentialCounter {
    // ─── State ───────────────────────────────────────────────────────────────

    /// @dev The encrypted counter. euint64 is an opaque ciphertext handle.
    ///      The contract never sees the plaintext value — only the coprocessor does.
    euint64 private _count;

    /// @dev Owner is the only address allowed to modify and read the counter.
    address public immutable owner;

    // ─── Events ──────────────────────────────────────────────────────────────

    /// @dev Never emit the encrypted value itself. Only emit that a change occurred.
    ///      AGENT RULE: Encrypted handles must not be emitted as event data.
    event CounterIncremented();
    event CounterDecremented();
    event CounterReset();

    // ─── Errors ──────────────────────────────────────────────────────────────

    error Unauthorized();
    error NotAuthorized();

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;

        // AGENT RULE-10: Always initialize encrypted state with FHE.asEuintXX(0).
        // A raw `euint64` declaration produces a zero handle (handle ID == 0),
        // which is INVALID for FHE operations. Always use FHE.asEuintXX().
        _count = FHE.asEuint64(0);

        // AGENT RULE-03: After every encrypted write, re-grant ACL.
        //   FHE.allowThis → the contract itself can use this handle in future txs.
        //   FHE.allow     → a specific address can request decryption via relayer.
        FHE.allowThis(_count);
        FHE.allow(_count, owner);
    }

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PATTERN A: Encrypted Input Validation + Arithmetic
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Increment the counter by an encrypted amount.
    /// @param encAmount  The encrypted increment value from the user's client.
    ///                   Type: externalEuint64 — a raw, unvalidated user ciphertext.
    /// @param inputProof The ZK proof that `encAmount` is well-formed.
    ///
    /// AGENT PATTERN — Input Handling (RULE-02):
    ///   externalEuint64  →  FHE.fromExternal(input, proof)  →  euint64
    ///   External inputs are NEVER used directly. fromExternal validates the ZK
    ///   proof and converts to a contract-usable handle. Without this step,
    ///   malicious users can submit malformed ciphertexts.
    function increment(
        externalEuint64 encAmount,
        bytes calldata inputProof
    ) external onlyOwner {
        // Step 1: Validate + convert user input.
        // fromExternal verifies the ZK proof on-chain before accepting the value.
        euint64 amount = FHE.fromExternal(encAmount, inputProof);

        // Step 2: Perform FHE arithmetic. Result is a new ciphertext handle.
        _count = FHE.add(_count, amount);

        // Step 3: Re-grant ACL on the NEW handle (RULE-03).
        // Every FHE operation returns a fresh handle. The old ACL is invalidated.
        // Skipping this causes silent runtime failures — the handle becomes
        // inaccessible to both the contract and the user.
        FHE.allowThis(_count);
        FHE.allow(_count, owner);

        emit CounterIncremented();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PATTERN B: Encrypted Branching with FHE.select (RULE-01, RULE-05)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Decrement the counter by an encrypted amount.
    ///         If amount > current count, the counter is clamped to 0 (no underflow).
    /// @param encAmount  The encrypted decrement value.
    /// @param inputProof ZK proof for well-formedness.
    ///
    /// AGENT PATTERN — Encrypted Branching:
    ///   ❌ FORBIDDEN:  if (FHE.ge(_count, amount)) { ... }    ← ebool ≠ bool
    ///   ❌ FORBIDDEN:  require(FHE.ge(...), "msg")            ← same reason
    ///   ✅ CORRECT:    FHE.select(condition, trueVal, falseVal)
    ///
    ///   FHE.select is the ONLY safe way to branch on encrypted conditions.
    ///   Both branches are always evaluated (FHE property — no short-circuit).
    ///   The coprocessor chooses the result based on the encrypted boolean.
    function decrement(
        externalEuint64 encAmount,
        bytes calldata inputProof
    ) external onlyOwner {
        euint64 amount = FHE.fromExternal(encAmount, inputProof);

        // Encrypted comparison — returns ebool (opaque; cannot be used in if/require)
        ebool canDecrement = FHE.ge(_count, amount);

        // FHE.select: if canDecrement → subtract; else → clamp to encrypted 0.
        // FHE.sub wraps on underflow — the select guard prevents reaching that case.
        _count = FHE.select(
            canDecrement,
            FHE.sub(_count, amount),
            FHE.asEuint64(0)
        );

        // Re-grant ACL on the handle produced by FHE.select.
        // The result of select is ALWAYS a new handle — old ACL does not carry over.
        FHE.allowThis(_count);
        FHE.allow(_count, owner);

        emit CounterDecremented();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PATTERN C: Conditional State Update via Encrypted Comparison
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Reset the counter to 0 only if it exceeds an encrypted threshold.
    ///         Demonstrates: encrypted comparison → conditional write → ACL re-grant.
    /// @param encThreshold The encrypted ceiling value.
    /// @param inputProof   ZK proof for the threshold value.
    ///
    /// AGENT PATTERN — Conditional Reset:
    ///   Compute BOTH outcomes, then FHE.select the correct one.
    ///   The EVM executes all branches — coprocessor resolves the choice privately.
    function resetIfOver(
        externalEuint64 encThreshold,
        bytes calldata inputProof
    ) external onlyOwner {
        euint64 threshold = FHE.fromExternal(encThreshold, inputProof);

        // Encrypted comparison: is count strictly greater than threshold?
        ebool exceeded = FHE.gt(_count, threshold);

        // If exceeded: write encrypted zero. If not: keep current handle.
        _count = FHE.select(exceeded, FHE.asEuint64(0), _count);

        FHE.allowThis(_count);
        FHE.allow(_count, owner);

        emit CounterReset();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PATTERN D: Exposing Encrypted Handles for Off-Chain Decryption (RULE-04)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Returns the encrypted counter handle for off-chain decryption.
    ///
    /// AGENT PATTERN — Reading Encrypted State:
    ///   This function returns the euint64 HANDLE, NOT the plaintext value.
    ///   The caller uses the relayer SDK (userDecrypt) to get the actual number.
    ///
    ///   Correct off-chain flow:
    ///     1. Caller invokes this view function to get the handle.
    ///     2. FHE.allow(_count, msg.sender) was called on write — grants access.
    ///     3. Off-chain: relayerClient.userDecrypt({ handle, signer, chainId, ... })
    ///     4. Plaintext value is returned only to the authorized signer — never on-chain.
    ///
    ///   ❌ NEVER do: return uint64(euint64.unwrap(_count))  — meaningless + insecure.
    ///   ❌ NEVER do: return plaintext directly from a transaction.
    function getCountHandle() external view onlyOwner returns (euint64) {
        // ACL guard: verify the caller was granted permission on this handle.
        if (!FHE.isAllowed(_count, msg.sender)) revert NotAuthorized();
        return _count;
    }
}
