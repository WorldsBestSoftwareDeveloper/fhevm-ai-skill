# FHEVM Examples — AI Agent Reference Implementations

> **Part of:** FHEVM Agent Safety & Development Skill
> **Purpose:** Pattern templates for AI-assisted confidential smart contract generation
> **Compatibility:** fhevm v0.6+, fhevm-contracts v0.6+, Solidity ^0.8.24

---

## What These Examples Are

These contracts are **not production dApps**. They are **behavioral reference patterns** — minimal, heavily annotated implementations that AI coding agents (Claude Code, Cursor, Windsurf, Copilot) use as generation templates.

Each contract is:
- **compile-oriented** — written to pass `npx hardhat compile` cleanly
- **pattern-focused** — one or two core FHEVM concepts per file
- **annotated for agents** — comments explain *why*, not just *what*
- **safety-demonstrating** — each file shows both the correct pattern and flags common mistakes

---

## Contract Index

### `ConfidentialCounter.sol` — Core Patterns Reference

**The entry point for any agent learning FHEVM.**

| Pattern Demonstrated | SKILL Rule |
|---|---|
| `externalEuint64` + `inputProof` → `FHE.fromExternal()` | RULE-02 |
| `FHE.add` / `FHE.sub` encrypted arithmetic | RULE-08 |
| `FHE.select` instead of `if(ebool)` | RULE-01, RULE-05 |
| ACL re-grant after every encrypted write | RULE-03 |
| Encrypted handle exposure for off-chain decryption | RULE-04 |
| Safe encrypted state initialization | RULE-10 |

**When to generate this pattern:**
- Any contract that stores and modifies a per-user or global encrypted numeric value
- Whenever encrypted conditional updates are needed (balance checks, threshold resets)
- As the minimal skeleton before adding more complex logic

---

### `ConfidentialERC7984Token.sol` — Encrypted Token Pattern

**The standard template for any confidential fungible asset.**

| Pattern Demonstrated | Notes |
|---|---|
| `ConfidentialERC20` inheritance | Do not re-implement transfer logic |
| Plaintext-amount owner mint | `_unsafeMint` + explicit `FHE.allow` |
| ACL grant on mint recipient | Required for userDecrypt off-chain |
| Balance handle exposure | View function with `FHE.isAllowed` guard |
| Total supply vs. balance asymmetry | Supply = public, balances = private |

**Why ERC-7984 over ERC-20:**
Standard ERC-20 leaks all balances and transfer amounts on-chain. ERC-7984 encrypts
balances and amounts while keeping total supply auditable. Use this for any application
requiring financial privacy: payroll, private DeFi, confidential governance weights.

**When to generate this pattern:**
- Any token where holder balances must remain private
- Any transfer system where amounts must not be observable
- As the base for more complex DeFi protocols requiring confidentiality

---

### `BlindAuction.sol` — Async Decryption + Encrypted Comparison

**The definitive example of multi-transaction FHE workflows.**

| Pattern Demonstrated | Notes |
|---|---|
| Encrypted bid submission | `externalEuint64` + `FHE.fromExternal` |
| Silent encrypted max-tracking | `FHE.select(FHE.gt(new, current), new, current)` |
| `ebool` comparison without branching | `FHE.gt` → `ebool` → `FHE.select` |
| Async state machine | `Active → PendingReveal → Revealed` |
| `Gateway.requestDecryption` | Transaction 1: request |
| `onlyGateway` callback | Transaction 2: receive plaintext |
| `FHE.allowTransient` | Same-transaction Gateway access |

**The two-transaction async model:**
```
Tx 1 — requestReveal():
  state = PendingReveal
  FHE.allowTransient(_highBid, Gateway)
  Gateway.requestDecryption(handles, callback, ...)

  [Gateway processes off-chain]

Tx 2 — revealCallback() [called by Gateway]:
  state = Revealed
  revealedWinningBid = decryptedValue
```
Never write code that uses the decrypted value in Tx 1. It does not exist yet.

**When to generate this pattern:**
- Any contract that must publicly reveal an encrypted result after a deadline
- Sealed-bid auctions, encrypted voting tallies, hidden-state games
- Any workflow requiring the "encrypted computation → async reveal" lifecycle

---

## How AI Agents Should Use These Examples

### As Generation Templates

When a user requests a confidential smart contract, agents should:

1. **Identify which pattern applies** using the SKILL.md decision tree (Section 4)
2. **Load the closest example** as the structural template
3. **Adapt** the state variables, function names, and business logic
4. **Preserve all FHEVM-specific patterns** — ACL grants, `FHE.select`, `fromExternal`
5. **Run the self-audit checklist** (SKILL.md Section 16) before outputting

### Pattern Mapping

| User Request | Primary Template | Key Pattern |
|---|---|---|
| "encrypted balance", "private counter" | `ConfidentialCounter` | Input + ACL + select |
| "private token", "confidential ERC20" | `ConfidentialERC7984Token` | ConfidentialERC20 base |
| "sealed auction", "hidden bid" | `BlindAuction` | Async decrypt + select |
| "blind voting", "private tally" | `BlindAuction` (adapt) | Async decrypt + accumulate |
| "private game state" | `ConfidentialCounter` (adapt) | Select + conditional update |

### What NOT to Copy Blindly

- Do not copy ACL grants without checking which addresses need access in your context
- Do not copy `onlyOwner` if your contract requires different access control
- Do not assume `_unsafeMint` is correct for all token supply models — review the base
- Do not remove `onlyGateway` from the callback — it is a security-critical guard

---

## Installation

```bash
npm install fhevm fhevm-contracts @openzeppelin/contracts
```

```bash
npx hardhat compile
```

Expected: `Compiled 3 Solidity files successfully` (zero errors)

---

## Related Skill Files

| File | Purpose |
|---|---|
| `/SKILL.md` | Full agent behavioral operating manual |
| `/prompts/` | Test prompts that produce correct output from agents |
| `/adversarial-tests/` | Unsafe prompts agents must reject |
| `/demo/` | Runnable Hardhat scripts for live demonstration |
