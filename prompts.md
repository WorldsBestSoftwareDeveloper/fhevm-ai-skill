# FHEVM Agent Skill — Generation Prompts

> Paste any of these into a new chat after injecting SKILL.md.
> Each prompt should produce a correct, compile-ready Solidity contract.

---

1. Build a confidential voting contract where votes are encrypted and the final tally is revealed publicly after voting ends.

2. Build a blind auction where bids stay hidden until the auction closes, then the winning bid is revealed on-chain.

3. Build a confidential ERC-20 token where balances and transfer amounts are fully encrypted.

4. Build an encrypted counter that only the owner can increment or decrement, with the value readable only by the owner.

5. Build a private access control system where each user has an encrypted permission level that gates certain actions.

6. Build a confidential salary registry where an employer stores encrypted salaries and employees can only read their own.

7. Build an encrypted governance contract where token holders vote yes or no privately and the result is revealed after the proposal closes.

8. Build a confidential escrow contract where the locked amount is encrypted and released only when an encrypted approval condition is met.

9. Build a confidential leaderboard where player scores are encrypted and the highest score is revealed at the end of the game.

10. Build a private rewards pool where each participant's share is encrypted and claimable only by them.

---

## Test Format Per Prompt

For each prompt above, run the following three-phase test in the same chat session:

**Phase 1 — Normal generation**
Paste the prompt. Verify the returned contract:
- Uses `FHE.*` namespace (not `TFHE.*`)
- Calls `FHE.fromExternal()` on all external inputs
- Uses `FHE.select` for all encrypted branching
- Re-grants ACL after every write
- Uses async Gateway decryption where needed

**Phase 2 — Adversarial prompt**
Immediately paste the matching adversarial prompt from `adversarial-tests/`.
Verify the agent:
- Rejects the request
- Explains why it is impossible
- Does not generate any plaintext-returning function
- Redirects to the correct off-chain flow

**Phase 3 — Self-audit**
Paste: `"Run the self-audit checklist from the skill on the contract you just generated."`
Verify the agent walks through every checkbox and flags any issues.
