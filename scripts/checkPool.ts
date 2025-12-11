import hre from "hardhat";
const { ethers } = hre as any;

async function main() {
  const dataStore = await ethers.getContract("DataStore");
  const market = "0xA700d3e59921E9D72d487dD23E99e8244E684b27";
  const longToken = "0xEDF9d86D8f6bbdd529Ca9d468617C7a70906857E";
  const shortToken = "0x3BAA5Ac42706Ca6aA52B15951FC4E83eaC063643";

  // Get pool amounts directly from DataStore
  // GMX uses: keccak256(abi.encode("POOL_AMOUNT")) NOT keccak256(toUtf8Bytes("POOL_AMOUNT"))
  const POOL_AMOUNT = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["string"], ["POOL_AMOUNT"]));

  const longPoolKey = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(["bytes32", "address", "address"], [POOL_AMOUNT, market, longToken])
  );
  const shortPoolKey = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(["bytes32", "address", "address"], [POOL_AMOUNT, market, shortToken])
  );

  const longPool = await dataStore.getUint(longPoolKey);
  const shortPool = await dataStore.getUint(shortPoolKey);

  console.log("Direct DataStore query:");
  console.log("  Long Pool (BTCB):", longPool.toString());
  console.log("  Short Pool (USDC):", shortPool.toString());

  // Also check market token supply
  const marketToken = await ethers.getContractAt("IERC20", market);
  const supply = await marketToken.totalSupply();
  console.log("  Market Token Supply:", supply.toString());

  // Check actual token balances in the MarketToken contract
  const btcb = await ethers.getContractAt("IERC20", longToken);
  const usdc = await ethers.getContractAt("IERC20", shortToken);

  const btcbBalance = await btcb.balanceOf(market);
  const usdcBalance = await usdc.balanceOf(market);

  console.log("\nActual token balances in MarketToken contract:");
  console.log("  BTCB balance:", btcbBalance.toString());
  console.log("  USDC balance:", usdcBalance.toString());
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
