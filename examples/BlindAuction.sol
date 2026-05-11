// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { FHE, euint64, externalEuint64, ebool } from "@fhevm/solidity/lib/FHE.sol";

contract BlindAuction {
    address public immutable beneficiary;
    uint256 public immutable auctionEnd;

    euint64 private _highBid;
    uint64 public revealedWinningBid;

    enum AuctionState { Active, Revealed }
    AuctionState public state;

    event BidSubmitted(address indexed bidder);
    event AuctionRevealed(uint64 winningBid);

    error AuctionNotActive();
    error AuctionStillRunning();
    error AlreadyRevealed();

    constructor(uint256 duration) {
        beneficiary = msg.sender;
        auctionEnd = block.timestamp + duration;
        state = AuctionState.Active;
        _highBid = FHE.asEuint64(0);
        FHE.allowThis(_highBid);
        FHE.allow(_highBid, msg.sender);
    }

    function bid(externalEuint64 encBid, bytes calldata inputProof) external {
        if (state != AuctionState.Active) revert AuctionNotActive();
        if (block.timestamp >= auctionEnd) revert AuctionStillRunning();

        euint64 bidAmount = FHE.fromExternal(encBid, inputProof);
        ebool isHigher = FHE.gt(bidAmount, _highBid);
        _highBid = FHE.select(isHigher, bidAmount, _highBid);

        FHE.allowThis(_highBid);
        FHE.allow(_highBid, beneficiary);
        emit BidSubmitted(msg.sender);
    }

    // Returns the encrypted high bid handle — beneficiary decrypts off-chain
    // In production this would use Gateway.requestDecryption for on-chain reveal
    function getHighBidHandle() external view returns (euint64) {
        require(FHE.isAllowed(_highBid, msg.sender), "Not authorized");
        return _highBid;
    }

    function getResult() external view returns (bool isRevealed, uint64 winningBid) {
        isRevealed = (state == AuctionState.Revealed);
        winningBid = isRevealed ? revealedWinningBid : 0;
    }
}