import hre from "hardhat";
const { ethers } = hre as any;

async function main() {
  const dataStore = await ethers.getContract("DataStore");

  const DEPOSIT_LIST_KEY = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("DEPOSIT_LIST"));
  const depositCount = await dataStore.getBytes32Count(DEPOSIT_LIST_KEY);
  console.log("Pending deposits:", depositCount.toString());

  if (depositCount.gt(0)) {
    const keys = await dataStore.getBytes32ValuesAt(DEPOSIT_LIST_KEY, 0, depositCount);
    console.log("Deposit keys:", keys);
  }

  // Check user's market token balance
  const [wallet] = await ethers.getSigners();
  const marketToken = await ethers.getContractAt("IERC20", "0xCCCe7028536b90A2B55E56e0051dbc6AD678dEA1");
  const balance = await marketToken.balanceOf(wallet.address);
  console.log("\nUser's GM token balance:", ethers.utils.formatEther(balance));
}

main().catch(console.error);
