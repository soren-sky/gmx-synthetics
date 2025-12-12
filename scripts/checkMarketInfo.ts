import hre from "hardhat";
const { ethers } = hre as any;

async function main() {
  const reader = await ethers.getContract("Reader");
  const dataStore = await ethers.getContract("DataStore");
  const marketAddress = "0xCCCe7028536b90A2B55E56e0051dbc6AD678dEA1";

  // Get market info using Reader
  const marketInfo = await reader.getMarket(dataStore.address, marketAddress);
  console.log("Market info:");
  console.log("  marketToken:", marketInfo.marketToken);
  console.log("  indexToken:", marketInfo.indexToken);
  console.log("  longToken:", marketInfo.longToken);
  console.log("  shortToken:", marketInfo.shortToken);

  // Get market token contract and check its balance of underlying tokens
  const longToken = await ethers.getContractAt("IERC20", marketInfo.longToken);
  const shortToken = await ethers.getContractAt("IERC20", marketInfo.shortToken);

  const longBalance = await longToken.balanceOf(marketAddress);
  const shortBalance = await shortToken.balanceOf(marketAddress);

  console.log("\nMarket contract token balances:");
  console.log("  Long token (WBNB):", ethers.utils.formatEther(longBalance));
  console.log("  Short token (USDC):", ethers.utils.formatUnits(shortBalance, 18));

  // Check GM token total supply
  const gmToken = await ethers.getContractAt("IERC20", marketAddress);
  const totalSupply = await gmToken.totalSupply();
  console.log("\nGM token total supply:", ethers.utils.formatEther(totalSupply));
}

main().catch(console.error);
