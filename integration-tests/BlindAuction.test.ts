/**
 * test/BlindAuction.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * FHEVM Agent Skill — BlindAuction Test Suite
 * ─────────────────────────────────────────────────────────────────────────────
 * Covers:
 *   1. Deployment + state machine initialization
 *   2. Encrypted bid submission
 *   3. Silent highest-bid tracking (FHE.select)
 *   4. Bid rejection after auction ends
 *   5. Async reveal flow (requestReveal → revealCallback)
 *   6. getResult() gated behind Revealed state
 *   7. Adversarial: bid reveal impossible during active auction
 *
 * Run:
 *   npx hardhat test test/BlindAuction.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { createFhevmInstance, FhevmInstance } from "fhevm";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { BlindAuction } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function encryptBid(
  fhevm: FhevmInstance,
  contractAddress: string,
  bidderAddress: string,
  amount: bigint
): Promise<{ handle: string; proof: string }> {
  const input = fhevm.createEncryptedInput(contractAddress, bidderAddress);
  input.add64(amount);
  const { handles, inputProof } = await input.encrypt();
  return { handle: handles[0], proof: inputProof };
}

const AUCTION_DURATION = 60; // seconds

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("BlindAuction", function () {
  let auction: BlindAuction;
  let contractAddress: string;
  let fhevm: FhevmInstance;
  let owner: SignerWithAddress;
  let bidder1: SignerWithAddress;
  let bidder2: SignerWithAddress;
  let gatewayAddress: string;

  before(async function () {
    [owner, bidder1, bidder2] = await ethers.getSigners();

    fhevm = await createFhevmInstance({
      networkUrl: "http://localhost:8545",
      gatewayUrl: "http://localhost:7077",
    });

    // The mock Gateway address used in local FHEVM testing
    gatewayAddress = await fhevm.getGatewayAddress();
  });

  beforeEach(async function () {
    const AuctionFactory = await ethers.getContractFactory("BlindAuction", owner);
    auction = (await AuctionFactory.deploy(AUCTION_DURATION)) as BlindAuction;
    await auction.waitForDeployment();
    contractAddress = await auction.getAddress();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Deployment
  // ─────────────────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets beneficiary to deployer", async function () {
      expect(await auction.beneficiary()).to.equal(owner.address);
    });

    it("initializes in Active state", async function () {
      // AuctionState.Active == 0
      expect(await auction.state()).to.equal(0);
    });

    it("sets auctionEnd in the future", async function () {
      const end = await auction.auctionEnd();
      const now = BigInt(await time.latest());
      expect(end).to.be.greaterThan(now);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Bidding
  // ─────────────────────────────────────────────────────────────────────────

  describe("bid()", function () {
    it("accepts a valid encrypted bid", async function () {
      const { handle, proof } = await encryptBid(
        fhevm,
        contractAddress,
        bidder1.address,
        100n
      );

      await expect(auction.connect(bidder1).bid(handle, proof))
        .to.emit(auction, "BidSubmitted")
        .withArgs(bidder1.address);
    });

    it("accepts multiple bids from different bidders", async function () {
      const bid1 = await encryptBid(fhevm, contractAddress, bidder1.address, 100n);
      const bid2 = await encryptBid(fhevm, contractAddress, bidder2.address, 200n);

      await (await auction.connect(bidder1).bid(bid1.handle, bid1.proof)).wait();
      await (await auction.connect(bidder2).bid(bid2.handle, bid2.proof)).wait();

      // Both bids accepted — highest bid tracked silently via FHE.select
      // No plaintext comparison occurs — coprocessor handles the max logic
    });

    it("rejects bids after auction ends", async function () {
      // Fast-forward past auction end
      await time.increase(AUCTION_DURATION + 1);

      const { handle, proof } = await encryptBid(
        fhevm,
        contractAddress,
        bidder1.address,
        100n
      );

      await expect(
        auction.connect(bidder1).bid(handle, proof)
      ).to.be.revertedWithCustomError(auction, "AuctionStillRunning");
    });

    it("rejects bids when auction is not in Active state", async function () {
      // Move to end and request reveal → PendingReveal state
      await time.increase(AUCTION_DURATION + 1);
      await (await auction.requestReveal()).wait();

      const { handle, proof } = await encryptBid(
        fhevm,
        contractAddress,
        bidder1.address,
        50n
      );

      await expect(
        auction.connect(bidder1).bid(handle, proof)
      ).to.be.revertedWithCustomError(auction, "AuctionNotActive");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Reveal Flow (Async Decryption)
  // ─────────────────────────────────────────────────────────────────────────

  describe("requestReveal() + revealCallback()", function () {
    beforeEach(async function () {
      // Submit two bids
      const bid1 = await encryptBid(fhevm, contractAddress, bidder1.address, 150n);
      const bid2 = await encryptBid(fhevm, contractAddress, bidder2.address, 300n);
      await (await auction.connect(bidder1).bid(bid1.handle, bid1.proof)).wait();
      await (await auction.connect(bidder2).bid(bid2.handle, bid2.proof)).wait();

      // End the auction
      await time.increase(AUCTION_DURATION + 1);
    });

    it("transitions to PendingReveal after requestReveal()", async function () {
      await (await auction.requestReveal()).wait();
      // AuctionState.PendingReveal == 1
      expect(await auction.state()).to.equal(1);
    });

    it("emits RevealRequested", async function () {
      await expect(auction.requestReveal()).to.emit(auction, "RevealRequested");
    });

    it("reverts if requestReveal called while auction still running", async function () {
      // Deploy fresh auction still within duration
      const AuctionFactory = await ethers.getContractFactory("BlindAuction", owner);
      const freshAuction = await AuctionFactory.deploy(9999);
      await freshAuction.waitForDeployment();

      await expect(
        freshAuction.requestReveal()
      ).to.be.revertedWithCustomError(freshAuction, "AuctionStillRunning");
    });

    it("completes full reveal via Gateway mock callback", async function () {
      const tx = await auction.requestReveal();
      const receipt = await tx.wait();

      // On the mock network, the FHEVM testing helpers simulate the Gateway callback
      // The mock Gateway automatically fires revealCallback with the decrypted value
      await fhevm.simulateDecryptionRequest(receipt, auction);

      // After callback: state == Revealed (2), revealedWinningBid is set
      expect(await auction.state()).to.equal(2);

      const { isRevealed, winningBid } = await auction.getResult();
      expect(isRevealed).to.be.true;

      // The highest of 150 and 300 should be 300
      expect(winningBid).to.equal(300n);
    });

    it("blocks double-reveal request", async function () {
      await (await auction.requestReveal()).wait();

      // Second call should fail — state is now PendingReveal, not Active
      await expect(auction.requestReveal()).to.be.revertedWithCustomError(
        auction,
        "WrongState"
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. getResult() state gate
  // ─────────────────────────────────────────────────────────────────────────

  describe("getResult()", function () {
    it("returns isRevealed=false and winningBid=0 before reveal", async function () {
      const { isRevealed, winningBid } = await auction.getResult();
      expect(isRevealed).to.be.false;
      expect(winningBid).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Adversarial — plaintext bid visibility impossible
  // ─────────────────────────────────────────────────────────────────────────

  describe("Adversarial — bid privacy", function () {
    it("bid amounts are not visible during active auction", async function () {
      const { handle, proof } = await encryptBid(
        fhevm,
        contractAddress,
        bidder1.address,
        500n
      );
      await (await auction.connect(bidder1).bid(handle, proof)).wait();

      // There is no function that returns the current highest bid as plaintext.
      // The only way to check: try calling a non-existent plaintext getter.
      // This asserts the contract does NOT expose such a function.
      expect((auction as any).getHighestBid).to.be.undefined;
      expect((auction as any).revealNow).to.be.undefined;

      // getResult() returns 0 while not yet revealed
      const { isRevealed, winningBid } = await auction.getResult();
      expect(isRevealed).to.be.false;
      expect(winningBid).to.equal(0n);
    });

    it("revealCallback cannot be called by non-Gateway address", async function () {
      await time.increase(AUCTION_DURATION + 1);
      await (await auction.requestReveal()).wait();

      // Attempt to fake the callback — should revert with onlyGateway guard
      await expect(
        auction.connect(bidder1).revealCallback(0, 9999n)
      ).to.be.reverted; // onlyGateway modifier blocks this
    });
  });
});
