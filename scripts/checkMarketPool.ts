import hre from "hardhat";
const { ethers } = hre as any;

async function main() {
  const reader = await ethers.getContract("Reader");
  const dataStore = await ethers.getContract("DataStore");

  // Markets to check
  const markets = ["0xCCCe7028536b90A2B55E56e0051dbc6AD678dEA1", "0xc490Ec0e53bD6Ac531aF869031dB183f73176839"];

  for (const marketAddr of markets) {
    console.log("\n=== Market:", marketAddr, "===");

    // Get market info
    const market = await reader.getMarket(dataStore.address, marketAddr);
    console.log("  marketToken:", market.marketToken);
    console.log("  indexToken:", market.indexToken);
    console.log("  longToken:", market.longToken);
    console.log("  shortToken:", market.shortToken);

    // Get pool amounts
    const POOL_AMOUNT_KEY = (token: string) =>
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32", "address", "address"],
          [ethers.utils.keccak256(ethers.utils.toUtf8Bytes("POOL_AMOUNT")), marketAddr, token]
        )
      );

    const longPoolAmount = await dataStore.getUint(POOL_AMOUNT_KEY(market.longToken));
    const shortPoolAmount = await dataStore.getUint(POOL_AMOUNT_KEY(market.shortToken));

    console.log("  longPoolAmount:", ethers.utils.formatEther(longPoolAmount));
    console.log("  shortPoolAmount:", ethers.utils.formatUnits(shortPoolAmount, 18));
  }
}

main().catch(console.error);
