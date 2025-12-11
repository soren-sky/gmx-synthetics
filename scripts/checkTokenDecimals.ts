import hre from "hardhat";
const { ethers } = hre as any;

async function main() {
  const market = "0xA700d3e59921E9D72d487dD23E99e8244E684b27";
  const longToken = "0xEDF9d86D8f6bbdd529Ca9d468617C7a70906857E";
  const shortToken = "0x3BAA5Ac42706Ca6aA52B15951FC4E83eaC063643";

  // Check actual decimals
  const longContract = await ethers.getContractAt("IERC20Metadata", longToken);
  const shortContract = await ethers.getContractAt("IERC20Metadata", shortToken);

  let longDecimals, shortDecimals;
  try {
    longDecimals = await longContract.decimals();
    console.log("Long Token (BTCB) decimals:", longDecimals);
  } catch (e) {
    console.log("Long Token decimals: error fetching");
  }

  try {
    shortDecimals = await shortContract.decimals();
    console.log("Short Token (USDC) decimals:", shortDecimals);
  } catch (e) {
    console.log("Short Token decimals: error fetching");
  }

  // Check DataStore for stored pool amounts
  const dataStore = await ethers.getContract("DataStore");

  // Using correct key format: keccak256(abi.encode("POOL_AMOUNT"))
  const POOL_AMOUNT = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["string"], ["POOL_AMOUNT"]));

  const longPoolKey = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(["bytes32", "address", "address"], [POOL_AMOUNT, market, longToken])
  );
  const shortPoolKey = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(["bytes32", "address", "address"], [POOL_AMOUNT, market, shortToken])
  );

  const longPool = await dataStore.getUint(longPoolKey);
  const shortPool = await dataStore.getUint(shortPoolKey);

  console.log("\nPool amounts from DataStore:");
  console.log("  Long Pool raw:", longPool.toString());
  console.log("  Short Pool raw:", shortPool.toString());

  // Show formatted with actual decimals
  if (longDecimals) {
    console.log("  Long Pool formatted:", ethers.utils.formatUnits(longPool, longDecimals));
  }
  if (shortDecimals) {
    console.log("  Short Pool formatted:", ethers.utils.formatUnits(shortPool, shortDecimals));
  }

  // Verify the oracle price format
  console.log("\n=== Price verification ===");

  // GMX Price format: price_per_token * FLOAT_PRECISION(10^30) / 10^token_decimals
  // For BTCB (18 decimals): 100000 * 10^30 / 10^18 = 10^17
  // For USDC (6 decimals):  1 * 10^30 / 10^6 = 10^24
  // For USDC (18 decimals): 1 * 10^30 / 10^18 = 10^12

  const FLOAT_PRECISION = ethers.BigNumber.from(10).pow(30);

  if (longDecimals) {
    const expectedBtcbPrice = ethers.BigNumber.from(100000)
      .mul(FLOAT_PRECISION)
      .div(ethers.BigNumber.from(10).pow(longDecimals));
    console.log("Expected BTCB price (at $100k, " + longDecimals + " decimals):", expectedBtcbPrice.toString());
  }

  if (shortDecimals) {
    const expectedUsdcPrice = ethers.BigNumber.from(1)
      .mul(FLOAT_PRECISION)
      .div(ethers.BigNumber.from(10).pow(shortDecimals));
    console.log("Expected USDC price (at $1, " + shortDecimals + " decimals):", expectedUsdcPrice.toString());
  }

  // Check market token supply
  const marketToken = await ethers.getContractAt("IERC20", market);
  const supply = await marketToken.totalSupply();
  console.log("\nMarket Token Supply:", ethers.utils.formatUnits(supply, 18));

  // Calculate pool value
  console.log("\n=== Pool value calculation ===");
  const btcbPriceFromOracle = ethers.BigNumber.from("100000000000000000"); // 10^17 from tx logs
  const usdcPriceFromOracle = ethers.BigNumber.from("1000000000000000000000000"); // 10^24 from tx logs

  const longPoolUsd = longPool.mul(btcbPriceFromOracle);
  const shortPoolUsd = shortPool.mul(usdcPriceFromOracle);
  const poolValueTotal = longPoolUsd.add(shortPoolUsd);

  console.log("Long pool USD value:", longPoolUsd.toString());
  console.log("Short pool USD value:", shortPoolUsd.toString());
  console.log("Total pool value:", poolValueTotal.toString());

  // In USD (divide by 10^30)
  console.log("\nIn actual USD:");
  console.log("Long pool USD:", ethers.utils.formatUnits(longPoolUsd, 30));
  console.log("Short pool USD:", ethers.utils.formatUnits(shortPoolUsd, 30));
  console.log("Total pool USD:", ethers.utils.formatUnits(poolValueTotal, 30));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
