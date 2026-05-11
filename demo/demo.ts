import { artifacts } from "hardhat";

type FunctionEntry = {
  type: string;
  name?: string;
};

async function functionNames(contractName: string): Promise<string[]> {
  const artifact = await artifacts.readArtifact(contractName);
  return artifact.abi
    .filter((entry: FunctionEntry) => entry.type === "function")
    .map((entry: FunctionEntry) => entry.name)
    .filter((name): name is string => Boolean(name))
    .sort();
}

async function main() {
  console.log("");
  console.log("FHEVM Agent Skill Demo");
  console.log("======================");
  console.log("");
  console.log("This local demo verifies the compiled example contracts and shows");
  console.log("the intended FHEVM flow. It does not perform live encryption because");
  console.log("that requires a relayer/coprocessor SDK running outside this repo.");
  console.log("");

  const examples = [
    {
      name: "ConfidentialCounter",
      patterns: [
        "external encrypted inputs",
        "FHE.add/FHE.sub arithmetic",
        "FHE.select encrypted branching",
        "encrypted handle read path",
      ],
    },
    {
      name: "ConfidentialERC7984Token",
      patterns: [
        "confidential balances",
        "owner minting",
        "encrypted transfer API",
        "plaintext total supply",
      ],
    },
    {
      name: "BlindAuction",
      patterns: [
        "encrypted bids",
        "private high-bid selection",
        "beneficiary-only handle access",
        "public result placeholder",
      ],
    },
  ];

  for (const example of examples) {
    const names = await functionNames(example.name);

    console.log(example.name);
    console.log("-".repeat(example.name.length));
    console.log(`Functions: ${names.join(", ")}`);
    console.log(`Patterns:  ${example.patterns.join("; ")}`);
    console.log("");
  }

  console.log("Live encrypted transaction flow:");
  console.log("1. Client encrypts a value with the relayer SDK for contract + user.");
  console.log("2. Client submits externalEuint64/einput plus its input proof.");
  console.log("3. Contract validates via FHE.fromExternal or TFHE.asEuint64.");
  console.log("4. Contract computes on ciphertext handles only.");
  console.log("5. Authorized users decrypt off-chain through the relayer.");
  console.log("");
  console.log("Demo complete.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
