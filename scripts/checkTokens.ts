import hre from "hardhat";
const { ethers } = hre as any;

async function main() {
  const [wallet] = await ethers.getSigners();
  const router = await ethers.getContract("Router");

  const shortTokenAddress = "0x3BAA5Ac42706Ca6aA52B15951FC4E83eaC063643";
  const shortToken = await ethers.getContractAt("IERC20", shortTokenAddress);

  const balance = await shortToken.balanceOf(wallet.address);
  const allowance = await shortToken.allowance(wallet.address, router.address);

  console.log("Short token (USDC):");
  console.log("  Balance:", ethers.utils.formatUnits(balance, 18));
  console.log("  Allowance to Router:", ethers.utils.formatUnits(allowance, 18));
  console.log("  Router:", router.address);

  // Check BNB balance
  const bnbBalance = await wallet.getBalance();
  console.log("\nBNB balance:", ethers.utils.formatEther(bnbBalance));
}

main().catch(console.error);
