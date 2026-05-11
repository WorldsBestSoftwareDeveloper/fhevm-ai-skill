import { expect } from "chai";
import { artifacts } from "hardhat";

describe("compiled FHEVM examples", function () {
  it("builds the ConfidentialCounter ABI", async function () {
    const artifact = await artifacts.readArtifact("ConfidentialCounter");
    const functionNames = artifact.abi
      .filter((entry) => entry.type === "function")
      .map((entry) => entry.name);

    expect(functionNames).to.include.members([
      "increment",
      "decrement",
      "resetIfOver",
      "getCountHandle",
    ]);
  });

  it("builds the ConfidentialERC7984Token ABI", async function () {
    const artifact = await artifacts.readArtifact("ConfidentialERC7984Token");
    const functionNames = artifact.abi
      .filter((entry) => entry.type === "function")
      .map((entry) => entry.name);

    expect(functionNames).to.include.members([
      "mint",
      "transfer",
      "balanceOf",
      "getMyBalanceHandle",
      "totalSupply",
    ]);
  });

  it("builds the BlindAuction ABI", async function () {
    const artifact = await artifacts.readArtifact("BlindAuction");
    const functionNames = artifact.abi
      .filter((entry) => entry.type === "function")
      .map((entry) => entry.name);

    expect(functionNames).to.include.members([
      "bid",
      "getHighBidHandle",
      "getResult",
    ]);
  });
});
