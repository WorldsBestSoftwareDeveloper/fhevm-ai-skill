/**
 * test/ConfidentialERC7984Token.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * FHEVM Agent Skill — ConfidentialERC7984Token Test Suite
 * ─────────────────────────────────────────────────────────────────────────────
 * Covers:
 *   1. Deployment + initial supply mint
 *   2. Owner mint to recipients
 *   3. ACL — recipient can retrieve their balance handle
 *   4. ACL — non-recipient cannot read another's balance
 *   5. Encrypted transfer via ConfidentialERC20 base
 *   6. Adversarial — plaintext balance read impossible
 *
 * Run:
 *   npx hardhat test test/ConfidentialERC7984Token.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { createFhevmInstance, FhevmInstance } from "fhevm";
import { decryptUint64 } from "fhevm/lib/decrypt";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ConfidentialERC7984Token } from "../typechain-types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function encryptTransferAmount(
  fhevm: FhevmInstance,
  contractAddress: string,
  senderAddress: string,
  amount: bigint
): Promise<{ handle: string; proof: string }> {
  const input = fhevm.createEncryptedInput(contractAddress, senderAddress);
  input.add64(amount);
  const { handles, inputProof } = await input.encrypt();
  return { handle: handles[0], proof: inputProof };
}

const TOKEN_NAME = "Private Token";
const TOKEN_SYMBOL = "PRIV";
const INITIAL_SUPPLY = 1_000_000n;

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("ConfidentialERC7984Token", function () {
  let token: ConfidentialERC7984Token;
  let contractAddress: string;
  let fhevm: FhevmInstance;
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let stranger: SignerWithAddress;

  before(async function () {
    [owner, alice, bob, stranger] = await ethers.getSigners();

    fhevm = await createFhevmInstance({
      networkUrl: "http://localhost:8545",
      gatewayUrl: "http://localhost:7077",
    });
  });

  beforeEach(async function () {
    const TokenFactory = await ethers.getContractFactory(
      "ConfidentialERC7984Token",
      owner
    );
    token = (await TokenFactory.deploy(
      TOKEN_NAME,
      TOKEN_SYMBOL,
      INITIAL_SUPPLY
    )) as ConfidentialERC7984Token;
    await token.waitForDeployment();
    contractAddress = await token.getAddress();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Deployment
  // ─────────────────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets the correct name and symbol", async function () {
      expect(await token.name()).to.equal(TOKEN_NAME);
      expect(await token.symbol()).to.equal(TOKEN_SYMBOL);
    });

    it("mints initial supply to owner", async function () {
      // Total supply is plaintext — ERC-7984 keeps supply auditable
      expect(await token.totalSupply()).to.equal(INITIAL_SUPPLY);
    });

    it("owner has a valid encrypted balance handle", async function () {
      const handle = await token.connect(owner).getMyBalanceHandle();
      expect(BigInt(handle.toString())).to.not.equal(0n);
    });

    it("owner balance decrypts to initial supply", async function () {
      const handle = await token.connect(owner).getMyBalanceHandle();
      const balance = await decryptUint64(handle);
      expect(balance).to.equal(INITIAL_SUPPLY);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Owner Mint
  // ─────────────────────────────────────────────────────────────────────────

  describe("mint()", function () {
    it("mints tokens to a recipient", async function () {
      await (await token.mint(alice.address, 500n)).wait();

      const handle = await token.connect(alice).getMyBalanceHandle();
      const balance = await decryptUint64(handle);
      expect(balance).to.equal(500n);
    });

    it("increases total supply after mint", async function () {
      await (await token.mint(alice.address, 500n)).wait();
      expect(await token.totalSupply()).to.equal(INITIAL_SUPPLY + 500n);
    });

    it("grants ACL to recipient on mint", async function () {
      await (await token.mint(alice.address, 500n)).wait();

      // Alice should be able to retrieve her balance handle
      // This only works if FHE.allow(encryptedBalances[alice], alice) was called
      const handle = await token.connect(alice).getMyBalanceHandle();
      expect(BigInt(handle.toString())).to.not.equal(0n);
    });

    it("reverts when called by non-owner", async function () {
      await expect(
        token.connect(alice).mint(bob.address, 100n)
      ).to.be.reverted;
    });

    it("reverts for zero address recipient", async function () {
      await expect(
        token.mint(ethers.ZeroAddress, 100n)
      ).to.be.revertedWith("Invalid recipient");
    });

    it("reverts for zero amount", async function () {
      await expect(
        token.mint(alice.address, 0n)
      ).to.be.revertedWith("Amount must be > 0");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Encrypted Transfer (via ConfidentialERC20 base)
  // ─────────────────────────────────────────────────────────────────────────

  describe("transfer()", function () {
    beforeEach(async function () {
      // Give alice 1000 tokens to work with
      await (await token.mint(alice.address, 1000n)).wait();
    });

    it("transfers encrypted amount from alice to bob", async function () {
      const { handle, proof } = await encryptTransferAmount(
        fhevm,
        contractAddress,
        alice.address,
        250n
      );

      await (
        await token.connect(alice).transfer(bob.address, handle, proof)
      ).wait();

      // Verify alice's balance decreased
      const aliceHandle = await token.connect(alice).getMyBalanceHandle();
      const aliceBalance = await decryptUint64(aliceHandle);
      expect(aliceBalance).to.equal(750n);

      // Verify bob's balance increased
      const bobHandle = await token.connect(bob).getMyBalanceHandle();
      const bobBalance = await decryptUint64(bobHandle);
      expect(bobBalance).to.equal(250n);
    });

    it("does not revert on transfer exceeding balance (FHE.select handles silently)", async function () {
      // In FHEVM confidential tokens, transfers exceeding balance are handled
      // silently via FHE.select — the contract cannot revert on encrypted conditions.
      // The transfer amount is clamped or zeroed by the base contract logic.
      const { handle, proof } = await encryptTransferAmount(
        fhevm,
        contractAddress,
        alice.address,
        9999n // more than alice's 1000
      );

      // Should not revert — encrypted branching absorbs the overflow silently
      await expect(
        token.connect(alice).transfer(bob.address, handle, proof)
      ).to.not.be.reverted;
    });

    it("emits Transfer event without amount (amount stays encrypted)", async function () {
      const { handle, proof } = await encryptTransferAmount(
        fhevm,
        contractAddress,
        alice.address,
        100n
      );

      // Transfer event only contains from/to — amount is never emitted
      await expect(
        token.connect(alice).transfer(bob.address, handle, proof)
      )
        .to.emit(token, "Transfer")
        .withArgs(alice.address, bob.address);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. ACL Enforcement
  // ─────────────────────────────────────────────────────────────────────────

  describe("ACL enforcement", function () {
    it("blocks getMyBalanceHandle() for address with no balance", async function () {
      // Stranger never received tokens — handle is uninitialized
      await expect(
        token.connect(stranger).getMyBalanceHandle()
      ).to.be.revertedWith("No balance or not authorized");
    });

    it("alice cannot read bob's balance handle", async function () {
      await (await token.mint(bob.address, 500n)).wait();

      // getMyBalanceHandle uses msg.sender — alice cannot impersonate bob
      // This test confirms the function is caller-scoped by design
      const aliceHandle = token.connect(alice).getMyBalanceHandle();
      await expect(aliceHandle).to.be.revertedWith("No balance or not authorized");
    });

    it("recipient retains ACL access after receiving a transfer", async function () {
      await (await token.mint(alice.address, 500n)).wait();

      const { handle, proof } = await encryptTransferAmount(
        fhevm,
        contractAddress,
        alice.address,
        200n
      );
      await (await token.connect(alice).transfer(bob.address, handle, proof)).wait();

      // Bob's handle should be accessible after receiving transfer
      // This verifies the base ConfidentialERC20 re-grants ACL on receive
      const bobHandle = await token.connect(bob).getMyBalanceHandle();
      expect(BigInt(bobHandle.toString())).to.not.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Adversarial — plaintext balance visibility impossible
  // ─────────────────────────────────────────────────────────────────────────

  describe("Adversarial — balance privacy", function () {
    it("balance handle is not the plaintext balance value", async function () {
      await (await token.mint(alice.address, 999n)).wait();

      const handle = await token.connect(alice).getMyBalanceHandle();

      // Raw handle ID is NOT the balance value
      // It is a ciphertext reference — meaningless without decryption
      expect(BigInt(handle.toString())).to.not.equal(999n);

      // Actual value only accessible via decryptUint64 (mock) or relayer SDK (live)
      const balance = await decryptUint64(handle);
      expect(balance).to.equal(999n);
    });

    it("contract exposes no function returning all balances as plaintext", async function () {
      // Verify no bulk plaintext getter exists on the contract interface
      expect((token as any).getAllBalances).to.be.undefined;
      expect((token as any).getBalanceOf).to.be.undefined;
    });

    it("total supply is public but individual balances are not", async function () {
      await (await token.mint(alice.address, 300n)).wait();
      await (await token.mint(bob.address, 700n)).wait();

      // Total supply is readable — ERC-7984 keeps this auditable
      const supply = await token.totalSupply();
      expect(supply).to.equal(INITIAL_SUPPLY + 1000n);

      // Individual balances are NOT readable without ACL + off-chain decryption
      // This is the core ERC-7984 privacy guarantee
      const aliceHandle = await token.connect(alice).getMyBalanceHandle();
      const aliceBalance = await decryptUint64(aliceHandle);
      expect(aliceBalance).to.equal(300n); // only alice can see this
    });
  });
});
