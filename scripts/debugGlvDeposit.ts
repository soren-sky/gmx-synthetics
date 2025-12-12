import hre from "hardhat";
const { ethers } = hre as any;

async function main() {
  const [wallet] = await ethers.getSigners();
  const glvReader = await ethers.getContract("GlvReader");
  const dataStore = await ethers.getContract("DataStore");

  const glvToken = "0x52044c4Ac7eb4a7e4A87f968655c6985075DF2E5";
  const marketAddress = "0xCCCe7028536b90A2B55E56e0051dbc6AD678dEA1";

  console.log("=== GLV Debug Info ===");

  // 1. Check GLV info
  const glvInfo = await glvReader.getGlvInfo(dataStore.address, glvToken);
  console.log("\nGLV Info:");
  console.log("  glvToken:", glvInfo.glv?.glvToken || glvInfo[0]?.glvToken);
  console.log("  longToken:", glvInfo.glv?.longToken || glvInfo[0]?.longToken);
  console.log("  shortToken:", glvInfo.glv?.shortToken || glvInfo[0]?.shortToken);
  console.log("  markets:", glvInfo.markets?.length || 0);

  // 2. Check if market is in GLV
  const markets = glvInfo.markets || [];
  const marketInGlv = markets.map((m: string) => m.toLowerCase()).includes(marketAddress.toLowerCase());
  console.log("\n  Market", marketAddress, "in GLV:", marketInGlv);

  // 3. Check GLV token balance and supply
  const glvTokenContract = await ethers.getContractAt("IERC20", glvToken);
  const glvSupply = await glvTokenContract.totalSupply();
  const userGlvBalance = await glvTokenContract.balanceOf(wallet.address);
  console.log("\nGLV Token:");
  console.log("  Total supply:", ethers.utils.formatEther(glvSupply));
  console.log("  User balance:", ethers.utils.formatEther(userGlvBalance));

  // 4. Check if GLV has GM tokens for this market
  const gmToken = await ethers.getContractAt("IERC20", marketAddress);
  const glvGmBalance = await gmToken.balanceOf(glvToken);
  console.log("\nGLV's GM token balance:", ethers.utils.formatEther(glvGmBalance));

  // 5. Check GlvVault
  const glvVault = await ethers.getContract("GlvVault");
  console.log("\nGlvVault address:", glvVault.address);

  // 6. Check if there's a pending GLV deposit
  const GLV_DEPOSIT_LIST_KEY = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("GLV_DEPOSIT_LIST"));
  const glvDepositCount = await dataStore.getBytes32Count(GLV_DEPOSIT_LIST_KEY);
  console.log("Pending GLV deposits:", glvDepositCount.toString());
}

main().catch(console.error);
