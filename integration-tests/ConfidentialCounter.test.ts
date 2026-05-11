/**
 * test/ConfidentialCounter.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * FHEVM Agent Skill — ConfidentialCounter Test Suite
 * ─────────────────────────────────────────────────────────────────────────────
 * Covers:
 *   1. Deployment + initialization
 *   2. Encrypted increment
 *   3. Encrypted decrement with underflow protection
 *   4. resetIfOver conditional logic
 *   5. ACL enforcement — unauthorized read blocked
 *   6. Adversarial: non-owner cannot call write functions
 *
 * Run:
 *   npx hardhat test test/ConfidentialCounter.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { createFhevmInstance, FhevmInstance } from "fhevm";
import { decryptUint64 } from "fhevm/lib/decrypt";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ConfidentialCounter } from "../typechain-types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encrypts a uint64 value for a specific contract + user combination.
 * Returns handles[0] (externalEuint64) and inputProof (bytes).
 *
 * FHEVM PATTERN: Every encrypted input is tied to a contract address + user
 * address pair. The ZK proof proves the ciphertext was made for this exact
 * context — preventing replay attacks across contracts.
 */
async function encryptUint64(
  fhevm: FhevmInstance,
  contractAddress: string,
  userAddress: string,
  value: bigint
): Promise<{ handle: string; proof: string }> {
  const input = fhevm.createEncryptedInput(contractAddress, userAddress);
  input.add64(value);
  const { handles, inputProof } = await input.encrypt();
  return { handle: handles[0], proof: inputProof };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("ConfidentialCounter", function () {
  let counter: ConfidentialCounter;
  let contractAddress: string;
  let fhevm: FhevmInstance;
  let owner: SignerWithAddress;
  let stranger: SignerWithAddress;

  // ── Before all: deploy + init FHEVM ────────────────────────────────────────
  before(async function () {
    [owner, stranger] = await ethers.getSigners();

    // Init FHEVM instance — connects to local mock coprocessor
    fhevm = await createFhevmInstance({
      networkUrl: "http://localhost:8545",
      gatewayUrl: "http://localhost:7077",
    });
  });

  // ── Before each: fresh deployment ──────────────────────────────────────────
  beforeEach(async function () {
    const CounterFactory = await ethers.getContractFactory(
      "ConfidentialCounter",
      owner
    );
    counter = (await CounterFactory.deploy()) as ConfidentialCounter;
    await counter.waitForDeployment();
    contractAddress = await counter.getAddress();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Deployment
  // ─────────────────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets the correct owner", async function () {
      expect(await counter.owner()).to.equal(owner.address);
    });

    it("initializes counter to encrypted zero (handle is non-zero)", async function () {
      // The handle should be a valid non-zero ID after FHE.asEuint64(0)
      const handle = await counter.getCountHandle();
      expect(BigInt(handle.toString())).to.not.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Increment
  // ─────────────────────────────────────────────────────────────────────────

  describe("increment()", function () {
    it("increments the counter by an encrypted amount", async function () {
      const { handle, proof } = await encryptUint64(
        fhevm,
        contractAddress,
        owner.address,
        42n
      );

      const tx = await counter.increment(handle, proof);
      await tx.wait();

      // Retrieve handle and decrypt on mock network
      const countHandle = await counter.getCountHandle();
      const value = await decryptUint64(countHandle);

      expect(value).to.equal(42n);
    });

    it("accumulates multiple increments correctly", async function () {
      for (const amount of [10n, 20n, 5n]) {
        const { handle, proof } = await encryptUint64(
          fhevm,
          contractAddress,
          owner.address,
          amount
        );
        await (await counter.increment(handle, proof)).wait();
      }

      const countHandle = await counter.getCountHandle();
      const value = await decryptUint64(countHandle);

      expect(value).to.equal(35n); // 10 + 20 + 5
    });

    it("emits CounterIncremented event", async function () {
      const { handle, proof } = await encryptUint64(
        fhevm,
        contractAddress,
        owner.address,
        1n
      );
      await expect(counter.increment(handle, proof))
        .to.emit(counter, "CounterIncremented");
    });

    it("reverts when called by non-owner", async function () {
      const { handle, proof } = await encryptUint64(
        fhevm,
        contractAddress,
        stranger.address,
        10n
      );
      await expect(
        counter.connect(stranger).increment(handle, proof)
      ).to.be.revertedWithCustomError(counter, "Unauthorized");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Decrement
  // ─────────────────────────────────────────────────────────────────────────

  describe("decrement()", function () {
    beforeEach(async function () {
      // Set counter to 50 before each decrement test
      const { handle, proof } = await encryptUint64(
        fhevm,
        contractAddress,
        owner.address,
        50n
      );
      await (await counter.increment(handle, proof)).wait();
    });

    it("decrements the counter by an encrypted amount", async function () {
      const { handle, proof } = await encryptUint64(
        fhevm,
        contractAddress,
        owner.address,
        20n
      );
      await (await counter.decrement(handle, proof)).wait();

      const countHandle = await counter.getCountHandle();
      const value = await decryptUint64(countHandle);

      expect(value).to.equal(30n); // 50 - 20
    });

    it("clamps to 0 instead of underflowing (FHE.select protection)", async function () {
      // Attempt to decrement by more than the current value
      // FHE.select(FHE.gte(count, amount), sub, 0) prevents underflow
      const { handle, proof } = await encryptUint64(
        fhevm,
        contractAddress,
        owner.address,
        100n // more than the 50 in counter
      );
      await (await counter.decrement(handle, proof)).wait();

      const countHandle = await counter.getCountHandle();
      const value = await decryptUint64(countHandle);

      // Must be 0 — NOT a wrapped negative (which would be a huge number)
      expect(value).to.equal(0n);
    });

    it("emits CounterDecremented event", async function () {
      const { handle, proof } = await encryptUint64(
        fhevm,
        contractAddress,
        owner.address,
        5n
      );
      await expect(counter.decrement(handle, proof))
        .to.emit(counter, "CounterDecremented");
    });

    it("reverts when called by non-owner", async function () {
      const { handle, proof } = await encryptUint64(
        fhevm,
        contractAddress,
        stranger.address,
        10n
      );
      await expect(
        counter.connect(stranger).decrement(handle, proof)
      ).to.be.revertedWithCustomError(counter, "Unauthorized");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. resetIfOver
  // ─────────────────────────────────────────────────────────────────────────

  describe("resetIfOver()", function () {
    beforeEach(async function () {
      // Set counter to 80
      const { handle, proof } = await encryptUint64(
        fhevm,
        contractAddress,
        owner.address,
        80n
      );
      await (await counter.increment(handle, proof)).wait();
    });

    it("resets to 0 when counter exceeds threshold", async function () {
      // threshold = 50, counter = 80 → should reset
      const { handle, proof } = await encryptUint64(
        fhevm,
        contractAddress,
        owner.address,
        50n
      );
      await (await counter.resetIfOver(handle, proof)).wait();

      const countHandle = await counter.getCountHandle();
      const value = await decryptUint64(countHandle);

      expect(value).to.equal(0n);
    });

    it("keeps counter unchanged when counter is below threshold", async function () {
      // threshold = 100, counter = 80 → should NOT reset
      const { handle, proof } = await encryptUint64(
        fhevm,
        contractAddress,
        owner.address,
        100n
      );
      await (await counter.resetIfOver(handle, proof)).wait();

      const countHandle = await counter.getCountHandle();
      const value = await decryptUint64(countHandle);

      expect(value).to.equal(80n); // unchanged
    });

    it("emits CounterReset event", async function () {
      const { handle, proof } = await encryptUint64(
        fhevm,
        contractAddress,
        owner.address,
        50n
      );
      await expect(counter.resetIfOver(handle, proof))
        .to.emit(counter, "CounterReset");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. ACL Enforcement
  // ─────────────────────────────────────────────────────────────────────────

  describe("ACL enforcement", function () {
    it("blocks getCountHandle() for non-owner", async function () {
      // stranger was never granted ACL via FHE.allow — should revert
      await expect(
        counter.connect(stranger).getCountHandle()
      ).to.be.revertedWithCustomError(counter, "Unauthorized");
    });

    it("owner can always retrieve the handle after writes", async function () {
      // Increment twice — each write produces a new handle + re-grants ACL
      for (const v of [10n, 20n]) {
        const { handle, proof } = await encryptUint64(
          fhevm,
          contractAddress,
          owner.address,
          v
        );
        await (await counter.increment(handle, proof)).wait();
      }

      // Owner should still be able to get handle after multiple ACL re-grants
      const handle = await counter.getCountHandle();
      expect(BigInt(handle.toString())).to.not.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Adversarial: plaintext read is impossible
  // ─────────────────────────────────────────────────────────────────────────

  describe("Adversarial — plaintext visibility", function () {
    it("getCountHandle() returns a handle, not a readable uint64", async function () {
      const { handle, proof } = await encryptUint64(
        fhevm,
        contractAddress,
        owner.address,
        99n
      );
      await (await counter.increment(handle, proof)).wait();

      const countHandle = await counter.getCountHandle();

      // The handle is a euint64 — its raw unwrapped value is NOT 99
      // It is a ciphertext reference ID, meaningless without decryption
      // This test asserts that the handle value ≠ the plaintext we put in
      expect(BigInt(countHandle.toString())).to.not.equal(99n);

      // Actual value only retrievable via decryptUint64 (mock) or relayer SDK (live)
      const decrypted = await decryptUint64(countHandle);
      expect(decrypted).to.equal(99n);
    });
  });
});
