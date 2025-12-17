import hre from "hardhat";
import { bigNumberify, expandDecimals } from "../utils/math";
import * as keys from "../utils/keys";

const { ethers } = hre as any;

/**
 * Keeper GLV Shift Script
 * Shift GM tokens within a GLV from one market to another (rebalancing)
 *
 * NOTE: This is a KEEPER-ONLY operation (requires ORDER_KEEPER role)
 *
 * Environment Variables:
 *   GLV_ADDRESS: GLV address (optional, auto-detect first GLV if not provided)
 *   FROM_MARKET: Source market within GLV (optional, auto-select market with most GM)
 *   TO_MARKET: Target market within GLV (optional, auto-select different market)
 *   SHIFT_AMOUNT: Amount of GM tokens to shift (optional)
 *   SHIFT_PERCENT: Percentage of FROM_MARKET GM tokens to shift (optional, default 50)
 *
 * Example:
 *   make keeper-glv-shift                          # Auto-detect GLV and markets
 *   GLV_ADDRESS=0x... FROM_MARKET=0x... TO_MARKET=0x... make keeper-glv-shift
 *   SHIFT_PERCENT=100 make keeper-glv-shift        # Shift 100% of GM from source market
 */

interface GlvInfo {
  glvToken: string;
  longToken: string;
  shortToken: string;
  markets: string[];
}

interface MarketBalance {
  market: string;
  balance: any; // BigNumber
}

async function getFirstGlv(): Promise<GlvInfo> {
  const glvReader = await ethers.getContract("GlvReader");
  const dataStore = await ethers.getContract("DataStore");

  const glvs = await glvReader.getGlvs(dataStore.address, 0, 10);

  if (glvs.length === 0) {
    throw new Error("No GLVs found! Please deploy GLV first with: make create-glv");
  }

  const glv = glvs[0];
  const glvInfo = await glvReader.getGlvInfo(dataStore.address, glv.glvToken);
  const markets = glvInfo.markets || glvInfo[1] || [];

  console.log("\nGLV Info:");
  console.log("  GLV Token:", glv.glvToken);
  console.log("  Long Token:", glv.longToken);
  console.log("  Short Token:", glv.shortToken);
  console.log("  Registered Markets:", markets.length);

  return {
    glvToken: glv.glvToken,
    longToken: glv.longToken,
    shortToken: glv.shortToken,
    markets,
  };
}

async function getGlvMarketBalances(glvToken: string, markets: string[]): Promise<MarketBalance[]> {
  const glvTokenContract = await ethers.getContractAt("GlvToken", glvToken);
  const balances: MarketBalance[] = [];

  for (const market of markets) {
    const balance = await glvTokenContract.tokenBalances(market);
    balances.push({ market, balance });
  }

  return balances;
}

async function main() {
  const [wallet] = await ethers.getSigners();
  console.log("Wallet address:", wallet.address);
  console.log("Wallet balance:", ethers.utils.formatEther(await wallet.getBalance()), "BNB");

  // Get contract instances
  const glvShiftHandler = await ethers.getContract("GlvShiftHandler");
  const dataStore = await ethers.getContract("DataStore");

  console.log("\nContract addresses:");
  console.log("  GlvShiftHandler:", glvShiftHandler.address);

  // Check if wallet has ORDER_KEEPER role
  // GMX uses keccak256(abi.encode("ORDER_KEEPER")) which is different from keccak256(toUtf8Bytes("ORDER_KEEPER"))
  const roleStore = await ethers.getContract("RoleStore");
  const ORDER_KEEPER_ROLE = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["string"], ["ORDER_KEEPER"]));
  const hasRole = await roleStore.hasRole(wallet.address, ORDER_KEEPER_ROLE);
  console.log("  Wallet has ORDER_KEEPER role:", hasRole);
  console.log("  ORDER_KEEPER role hash:", ORDER_KEEPER_ROLE);

  if (!hasRole) {
    console.error("\nError: Wallet does not have ORDER_KEEPER role!");
    console.error("GLV Shift can only be executed by keepers.");
    console.error("Please grant ORDER_KEEPER role to your wallet first.");
    process.exit(1);
  }

  // Get GLV info
  let glvToken: string;
  let markets: string[];

  if (process.env.GLV_ADDRESS) {
    glvToken = process.env.GLV_ADDRESS;
    const glvReader = await ethers.getContract("GlvReader");
    const glvInfo = await glvReader.getGlvInfo(dataStore.address, glvToken);
    markets = glvInfo.markets || glvInfo[1] || [];
    console.log("\nUsing specified GLV:", glvToken);
    console.log("  Registered Markets:", markets.length);
  } else {
    const glvInfo = await getFirstGlv();
    glvToken = glvInfo.glvToken;
    markets = glvInfo.markets;
  }

  if (markets.length < 2) {
    console.error("\nError: GLV needs at least 2 markets for shift operation!");
    console.error("Current markets:", markets.length);
    process.exit(1);
  }

  // Get GM token balances in GLV for each market
  console.log("\n=== GLV Market Balances ===");
  const marketBalances = await getGlvMarketBalances(glvToken, markets);

  marketBalances.forEach((mb, i) => {
    const balanceStr = ethers.utils.formatEther(mb.balance);
    console.log(`  [${i}] ${mb.market}: ${balanceStr} GM`);
  });

  // Determine fromMarket (source)
  let fromMarket = process.env.FROM_MARKET;
  if (!fromMarket) {
    // Auto-select market with highest balance
    const sortedByBalance = [...marketBalances].sort((a, b) => (b.balance.sub(a.balance).gt(0) ? 1 : -1));

    if (sortedByBalance[0].balance.eq(0)) {
      console.error("\nError: All markets have 0 GM balance in GLV!");
      console.error("Please deposit to GLV first using 'make user-glv-deposit'");
      process.exit(1);
    }

    fromMarket = sortedByBalance[0].market;
    console.log("\nAuto-selected FROM_MARKET (highest balance):", fromMarket);
    console.log("  Balance:", ethers.utils.formatEther(sortedByBalance[0].balance), "GM");
  }

  // Verify fromMarket exists in GLV
  const fromMarketBalance = marketBalances.find((mb) => mb.market.toLowerCase() === fromMarket!.toLowerCase());
  if (!fromMarketBalance) {
    console.error("\nError: FROM_MARKET not found in GLV markets!");
    process.exit(1);
  }

  if (fromMarketBalance.balance.eq(0)) {
    console.error("\nError: FROM_MARKET has 0 GM balance in GLV!");
    process.exit(1);
  }

  // Determine toMarket (target)
  let toMarket = process.env.TO_MARKET;
  if (!toMarket) {
    // Auto-select different market (prefer one with lower balance)
    const sortedByBalance = [...marketBalances]
      .filter((mb) => mb.market.toLowerCase() !== fromMarket!.toLowerCase())
      .sort((a, b) => (a.balance.sub(b.balance).gt(0) ? 1 : -1));

    if (sortedByBalance.length === 0) {
      console.error("\nError: No other market available for shift!");
      process.exit(1);
    }

    toMarket = sortedByBalance[0].market;
    console.log("Auto-selected TO_MARKET (lowest balance):", toMarket);
    console.log("  Balance:", ethers.utils.formatEther(sortedByBalance[0].balance), "GM");
  }

  // Verify toMarket
  const toMarketBalance = marketBalances.find((mb) => mb.market.toLowerCase() === toMarket!.toLowerCase());
  if (!toMarketBalance) {
    console.error("\nError: TO_MARKET not found in GLV markets!");
    process.exit(1);
  }

  if (fromMarket.toLowerCase() === toMarket.toLowerCase()) {
    console.error("\nError: FROM_MARKET and TO_MARKET must be different");
    process.exit(1);
  }

  // Check BOTH source and target market liquidity
  console.log("\n=== Checking Market Liquidity ===");
  const reader = await ethers.getContract("Reader");

  // Helper function to get pool USD value
  async function getPoolUsdValue(market: string) {
    const marketInfo = await reader.getMarket(dataStore.address, market);
    const poolLong = await dataStore.getUint(keys.poolAmountKey(market, marketInfo.longToken));
    const poolShort = await dataStore.getUint(keys.poolAmountKey(market, marketInfo.shortToken));
    const shortTokenContract = await ethers.getContractAt("IERC20Metadata", marketInfo.shortToken);
    const shortDecimals = await shortTokenContract.decimals();
    const shortTokenMultiplier = ethers.BigNumber.from(10).pow(18 - shortDecimals);
    const poolUsd = poolLong.mul(700).add(poolShort.mul(shortTokenMultiplier));

    const gmToken = await ethers.getContractAt("MarketToken", market);
    const gmSupply = await gmToken.totalSupply();

    return { poolLong, poolShort, poolUsd, gmSupply, marketInfo };
  }

  // Get source market info (CRITICAL - this is where the withdrawal happens!)
  console.log("\n  --- Source Market (FROM) ---");
  const fromMarketData = await getPoolUsdValue(fromMarket);
  console.log("  Pool Long (WBNB):", ethers.utils.formatEther(fromMarketData.poolLong));
  console.log("  Pool Short:", ethers.utils.formatEther(fromMarketData.poolShort));
  console.log("  Pool USD:", ethers.utils.formatEther(fromMarketData.poolUsd));
  console.log("  GM Supply:", ethers.utils.formatEther(fromMarketData.gmSupply));
  console.log("  GLV's GM Balance:", ethers.utils.formatEther(fromMarketBalance.balance));

  // Calculate what percentage of pool the GLV holds
  const glvPoolPercent = fromMarketBalance.balance.mul(100).div(fromMarketData.gmSupply);
  console.log("  GLV holds:", glvPoolPercent.toString(), "% of market's GM supply");

  // Get target market info
  console.log("\n  --- Target Market (TO) ---");
  const toMarketData = await getPoolUsdValue(toMarket);
  console.log("  Pool Long (WBNB):", ethers.utils.formatEther(toMarketData.poolLong));
  console.log("  Pool Short:", ethers.utils.formatEther(toMarketData.poolShort));
  console.log("  Pool USD:", ethers.utils.formatEther(toMarketData.poolUsd));
  console.log("  GM Supply:", ethers.utils.formatEther(toMarketData.gmSupply));

  // Check GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR
  const glvShiftMaxPriceImpactFactor = await dataStore.getUint(keys.glvShiftMaxPriceImpactFactorKey(glvToken));
  // GMX uses FLOAT_PRECISION = 1e30, so 1% = 1e28
  const maxImpactPercentValue = (parseFloat(glvShiftMaxPriceImpactFactor.toString()) / 1e30) * 100;
  console.log("\n  GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR:", glvShiftMaxPriceImpactFactor.toString());
  console.log("  = ", maxImpactPercentValue, "%");

  if (glvShiftMaxPriceImpactFactor.eq(0)) {
    console.error("\nError: GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR is 0!");
    console.error("Please set it first using DataStore.setUint");
    process.exit(1);
  }

  // Check if source market has enough liquidity
  if (fromMarketData.poolUsd.eq(0)) {
    console.error("\n!!! ERROR: Source market has NO liquidity !!!");
    console.error("Cannot withdraw GM tokens from an empty pool.");
    process.exit(1);
  }

  // Check if target market has liquidity
  if (toMarketData.poolUsd.eq(0)) {
    console.error("\n!!! ERROR: Target market has NO liquidity !!!");
    console.error("GLV shift will fail with extreme price impact.");
    console.error("\nPlease add liquidity to target market first:");
    console.error("  make user-deposit-doge");
    process.exit(1);
  }

  // The smaller pool determines the bottleneck
  const totalPoolUsd = fromMarketData.poolUsd.lt(toMarketData.poolUsd) ? fromMarketData.poolUsd : toMarketData.poolUsd;
  console.log("\n  Bottleneck Pool USD:", ethers.utils.formatEther(totalPoolUsd), "(smaller of source/target)");

  // Calculate shift amount
  let shiftAmount;
  if (process.env.SHIFT_AMOUNT) {
    shiftAmount = expandDecimals(parseInt(process.env.SHIFT_AMOUNT), 18);
  } else {
    const shiftPercent = process.env.SHIFT_PERCENT ? parseInt(process.env.SHIFT_PERCENT) : 50;
    shiftAmount = fromMarketBalance.balance.mul(shiftPercent).div(100);
    console.log("  Shift Percent:", shiftPercent, "%");
  }

  // Ensure we don't try to shift more than available
  if (shiftAmount.gt(fromMarketBalance.balance)) {
    console.log("  Adjusting shift amount to max balance");
    shiftAmount = fromMarketBalance.balance;
  }

  if (shiftAmount.eq(0)) {
    console.error("\nError: Shift amount is 0!");
    process.exit(1);
  }

  // Estimate price impact - GMX formula:
  // priceImpact = (marketTokensUsd - receivedMarketTokensUsd) / marketTokensUsd
  // In FLOAT_PRECISION (1e30): priceImpact * 1e30
  console.log("\n=== Price Impact Estimation ===");

  // Calculate the USD value of GM tokens being shifted
  // GM value = (shiftAmount / gmSupply) * poolUsd
  const shiftValueUsd = shiftAmount.mul(fromMarketData.poolUsd).div(fromMarketData.gmSupply);
  console.log("  Shift Value (USD):", ethers.utils.formatEther(shiftValueUsd));

  // The shift represents this percentage of source pool
  const sourcePoolPercent =
    (parseFloat(shiftValueUsd.toString()) / parseFloat(fromMarketData.poolUsd.toString())) * 100;
  console.log("  % of Source Pool:", sourcePoolPercent.toFixed(2), "%");

  // Very rough estimation: assume ~20% of shift value is lost to price impact
  // (This is conservative - actual depends on swap impact curves)
  const estimatedLossPercent = Math.min(sourcePoolPercent * 0.5, 50); // Cap at 50%
  console.log("  Estimated Loss:", estimatedLossPercent.toFixed(2), "%");
  console.log("  Max Allowed:", maxImpactPercentValue, "%");

  if (estimatedLossPercent > maxImpactPercentValue) {
    console.log("\n⚠️  Estimated price impact may exceed max allowed!");
    console.log("  Reducing shift amount...");

    // Calculate safe shift: max_impact% / (loss_rate * 100) * poolUsd
    // loss_rate ≈ 0.5 (50% of pool% becomes loss%)
    const safePoolPercent = maxImpactPercentValue / 0.5;
    const maxSafeShift = fromMarketData.gmSupply.mul(Math.floor(safePoolPercent * 100)).div(10000);

    console.log("  Original shift:", ethers.utils.formatEther(shiftAmount), "GM");
    console.log(
      "  Max safe shift:",
      ethers.utils.formatEther(maxSafeShift),
      "GM (",
      safePoolPercent.toFixed(2),
      "% of supply)"
    );

    if (maxSafeShift.lt(ethers.utils.parseEther("0.1"))) {
      console.log("\n  Pool too small for safe shift with current max impact setting.");
      console.log("  Proceeding anyway since max impact is now set to", maxImpactPercentValue, "%");
    } else {
      shiftAmount = maxSafeShift;
    }
  } else {
    console.log("\n  ✅ Shift amount within estimated safe range");
  }

  console.log("\n=== GLV Shift Details ===");
  console.log("  GLV Token:", glvToken);
  console.log("  From Market:", fromMarket);
  console.log("  To Market:", toMarket);
  console.log("  Shift Amount:", ethers.utils.formatEther(shiftAmount), "GM");

  // Build GLV Shift params
  const params = {
    glv: glvToken,
    fromMarket: fromMarket,
    toMarket: toMarket,
    marketTokenAmount: shiftAmount,
    minMarketTokens: bigNumberify(0), // No minimum, accept any amount
  };

  console.log("\nCreating GLV shift...");

  // Simulate transaction
  console.log("\nSimulating transaction...");
  try {
    await glvShiftHandler.callStatic.createGlvShift(params, {
      gasLimit: 3000000,
    });
    console.log("Simulation successful");
  } catch (e: any) {
    console.error("Simulation failed:", e.message);
    console.log("\nPossible reasons:");
    console.log("  - Wallet does not have ORDER_KEEPER role");
    console.log("  - GLV shift feature is disabled");
    console.log("  - GLV shift interval not yet passed");
    console.log("  - Insufficient GM balance in fromMarket");
    console.log("  - Markets not properly configured in GLV");
    process.exit(1);
  }

  // Execute transaction
  console.log("\nSending transaction...");
  const tx = await glvShiftHandler.createGlvShift(params, {
    gasLimit: 3000000,
  });

  console.log("Transaction hash:", tx.hash);
  console.log("Waiting for confirmation...");

  const receipt = await tx.wait();
  console.log("\nTransaction confirmed!");
  console.log("  Block:", receipt.blockNumber);
  console.log("  Gas used:", receipt.gasUsed.toString());
  console.log("  Status:", receipt.status === 1 ? "Success" : "Failed");

  // Query pending GLV shifts count
  const GLV_SHIFT_LIST_KEY = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("GLV_SHIFT_LIST"));
  const glvShiftCount = await dataStore.getBytes32Count(GLV_SHIFT_LIST_KEY);
  console.log("\nTotal pending GLV shifts:", glvShiftCount.toString());

  console.log("\n=== GLV Shift request created successfully! ===");
  console.log("The shift will be executed by a keeper (via executeGlvShift).");
  console.log("\nAfter execution:");
  console.log("  - GM tokens will be moved from", fromMarket.slice(0, 10) + "...");
  console.log("  - To market", toMarket.slice(0, 10) + "...");
  console.log("  - GLV's market composition will be rebalanced");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
