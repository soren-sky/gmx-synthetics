import hre from "hardhat";
import { bigNumberify, expandDecimals } from "../utils/math";
import { ExchangeRouter, MintableToken } from "../typechain-types";

const { ethers, deployments } = hre as any;

/**
 * User Shift Script
 * Shift GM tokens from one market to another market
 *
 * Environment Variables:
 *   FROM_MARKET: Source market address (optional, auto-detect if not provided)
 *   TO_MARKET: Target market address (optional, auto-select different market)
 *   SHIFT_AMOUNT: Amount of GM tokens to shift (optional)
 *   SHIFT_PERCENT: Percentage of GM tokens to shift (optional, default 50)
 *
 * Prerequisites: User must have GM tokens from the source market (from a previous deposit)
 *
 * Example:
 *   make user-shift                          # Auto-detect from/to markets
 *   FROM_MARKET=0x... TO_MARKET=0x... make user-shift
 *   SHIFT_PERCENT=100 make user-shift        # Shift 100% of GM tokens
 */

interface MarketWithBalance {
  marketToken: string;
  indexToken: string;
  longToken: string;
  shortToken: string;
  balance: any; // BigNumber
}

async function getTokenDecimals(tokenAddress: string): Promise<number> {
  try {
    const token = await ethers.getContractAt("IERC20Metadata", tokenAddress);
    return await token.decimals();
  } catch {
    return 18;
  }
}

async function getMarketInfo(marketAddress: string): Promise<{
  longToken: string;
  shortToken: string;
  indexToken: string;
  longDecimals: number;
  shortDecimals: number;
}> {
  const reader = await ethers.getContract("Reader");
  const dataStore = await ethers.getContract("DataStore");

  const marketInfo = await reader.getMarket(dataStore.address, marketAddress);
  const longDecimals = await getTokenDecimals(marketInfo.longToken);
  const shortDecimals = await getTokenDecimals(marketInfo.shortToken);

  return {
    longToken: marketInfo.longToken,
    shortToken: marketInfo.shortToken,
    indexToken: marketInfo.indexToken,
    longDecimals,
    shortDecimals,
  };
}

async function getMarketsWithBalances(walletAddress: string): Promise<MarketWithBalance[]> {
  const reader = await ethers.getContract("Reader");
  const dataStore = await ethers.getContract("DataStore");

  const markets = await reader.getMarkets(dataStore.address, 0, 100);
  const marketsWithBalances: MarketWithBalance[] = [];

  for (const market of markets) {
    const gmToken = await ethers.getContractAt("IERC20", market.marketToken);
    const balance = await gmToken.balanceOf(walletAddress);
    marketsWithBalances.push({
      marketToken: market.marketToken,
      indexToken: market.indexToken,
      longToken: market.longToken,
      shortToken: market.shortToken,
      balance,
    });
  }

  return marketsWithBalances;
}

async function getAvailableMarkets(): Promise<string[]> {
  const reader = await ethers.getContract("Reader");
  const dataStore = await ethers.getContract("DataStore");

  const markets = await reader.getMarkets(dataStore.address, 0, 100);
  return markets.map((m: any) => m.marketToken);
}

const WNT_KEY = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("WNT"));

async function getWntAddress(): Promise<string> {
  if (process.env.WBNB_ADDRESS) return process.env.WBNB_ADDRESS;
  try {
    const dataStore = await ethers.getContract("DataStore");
    const wntAddress = await dataStore.getAddress(WNT_KEY);
    if (wntAddress && wntAddress !== ethers.constants.AddressZero) return wntAddress;
  } catch (_e) {
    // DataStore not available
  }
  try {
    const wbnb = await deployments.get("WBNB");
    return wbnb.address;
  } catch (_e) {
    // WBNB not deployed
  }
  return "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
}

async function main() {
  const [wallet] = await ethers.getSigners();
  console.log("Wallet address:", wallet.address);
  console.log("Wallet balance:", ethers.utils.formatEther(await wallet.getBalance()), "BNB");

  // Get contract instances
  const exchangeRouter: ExchangeRouter = await ethers.getContract("ExchangeRouter");
  const router = await ethers.getContract("Router");
  const shiftVault = await ethers.getContract("ShiftVault");
  const dataStore = await ethers.getContract("DataStore");

  console.log("\nContract addresses:");
  console.log("  ExchangeRouter:", exchangeRouter.address);
  console.log("  Router:", router.address);
  console.log("  ShiftVault:", shiftVault.address);

  // Get all markets with user balances
  console.log("\nScanning markets for GM token balances...");
  const marketsWithBalances = await getMarketsWithBalances(wallet.address);

  // Show all markets and balances
  console.log("\nAll Markets:");
  marketsWithBalances.forEach((m, i) => {
    const balanceStr = ethers.utils.formatEther(m.balance);
    const hasBalance = !m.balance.isZero();
    console.log(`  [${i}] ${m.marketToken} ${hasBalance ? `(${balanceStr} GM)` : "(no balance)"}`);
  });

  // Find markets with balance
  const marketsWithGM = marketsWithBalances.filter((m) => !m.balance.isZero());

  // Determine fromMarket
  let fromMarket = process.env.FROM_MARKET;
  if (!fromMarket) {
    if (marketsWithGM.length === 0) {
      console.error("\nError: No GM tokens found in any market!");
      console.log("Please deposit to a market first using 'make user-deposit'");
      process.exit(1);
    }
    // Auto-select first market with balance
    fromMarket = marketsWithGM[0].marketToken;
    console.log("\nAuto-selected FROM_MARKET:", fromMarket);
    console.log("  Balance:", ethers.utils.formatEther(marketsWithGM[0].balance), "GM");
  }

  // Determine toMarket
  let toMarket = process.env.TO_MARKET;
  if (!toMarket) {
    // Find a compatible market (same long/short tokens preferred)
    const fromInfo = marketsWithBalances.find((m) => m.marketToken.toLowerCase() === fromMarket!.toLowerCase());
    if (!fromInfo) {
      console.error("\nError: FROM_MARKET not found in markets list");
      process.exit(1);
    }

    // Find compatible markets (same long/short tokens - REQUIRED for shift)
    const compatibleMarkets = marketsWithBalances.filter(
      (m) =>
        m.marketToken.toLowerCase() !== fromMarket!.toLowerCase() &&
        m.longToken.toLowerCase() === fromInfo.longToken.toLowerCase() &&
        m.shortToken.toLowerCase() === fromInfo.shortToken.toLowerCase()
    );

    if (compatibleMarkets.length > 0) {
      toMarket = compatibleMarkets[0].marketToken;
      console.log("\nAuto-selected TO_MARKET (compatible tokens):", toMarket);
    } else {
      // No compatible market - Shift REQUIRES same long/short tokens
      console.error("\nError: No compatible market found for shift!");
      console.error("Shift requires FROM and TO markets to have the SAME long token AND short token.");
      console.error("\nSource market (FROM):", fromMarket);
      console.error("  Long Token:", fromInfo.longToken);
      console.error("  Short Token:", fromInfo.shortToken);
      console.error("\nAvailable markets with different tokens:");
      marketsWithBalances
        .filter((m) => m.marketToken.toLowerCase() !== fromMarket!.toLowerCase())
        .forEach((m) => {
          console.error(`  ${m.marketToken}`);
          console.error(`    Long: ${m.longToken}`);
          console.error(`    Short: ${m.shortToken}`);
        });
      console.error("\nTo use shift, you need markets with matching long/short token pairs.");
      console.error("Alternative: Use withdraw from source market + deposit to target market.");
      process.exit(1);
    }
  }

  if (fromMarket.toLowerCase() === toMarket.toLowerCase()) {
    console.error("\nError: FROM_MARKET and TO_MARKET must be different");
    process.exit(1);
  }

  // Get market info
  console.log("\nSource Market (FROM):", fromMarket);
  const fromMarketInfo = await getMarketInfo(fromMarket);
  console.log("  Long Token:", fromMarketInfo.longToken);
  console.log("  Short Token:", fromMarketInfo.shortToken);
  console.log("  Index Token:", fromMarketInfo.indexToken);

  console.log("\nTarget Market (TO):", toMarket);
  const toMarketInfo = await getMarketInfo(toMarket);
  console.log("  Long Token:", toMarketInfo.longToken);
  console.log("  Short Token:", toMarketInfo.shortToken);
  console.log("  Index Token:", toMarketInfo.indexToken);

  // Verify markets have compatible tokens (same long/short tokens for shift)
  const fromLong = fromMarketInfo.longToken.toLowerCase();
  const fromShort = fromMarketInfo.shortToken.toLowerCase();
  const toLong = toMarketInfo.longToken.toLowerCase();
  const toShort = toMarketInfo.shortToken.toLowerCase();

  if (fromLong !== toLong || fromShort !== toShort) {
    console.warn("\nWarning: Markets have different underlying tokens");
    console.warn("  This shift may involve token swaps and potential slippage");
  }

  // Get WNT address
  const wntAddress = await getWntAddress();
  console.log("\n  WNT:", wntAddress);

  // Get GM token (from market) balance
  const gmToken: MintableToken = await ethers.getContractAt("MintableToken", fromMarket);
  const gmBalance = await gmToken.balanceOf(wallet.address);
  console.log("\nUser GM Token Balance (source market):", ethers.utils.formatEther(gmBalance), "GM");

  if (gmBalance.eq(0)) {
    console.error("\nError: No GM tokens to shift!");
    console.log("Please deposit to the source market first using 'make user-deposit'");
    process.exit(1);
  }

  // Calculate shift amount
  let shiftAmount;
  if (process.env.SHIFT_AMOUNT) {
    shiftAmount = expandDecimals(parseInt(process.env.SHIFT_AMOUNT), 18);
  } else {
    const shiftPercent = process.env.SHIFT_PERCENT ? parseInt(process.env.SHIFT_PERCENT) : 50;
    shiftAmount = gmBalance.mul(shiftPercent).div(100);
    console.log("  Shift Percent:", shiftPercent, "%");
  }

  // Ensure we don't try to shift more than we have
  if (shiftAmount.gt(gmBalance)) {
    console.log("  Adjusting shift amount to max balance");
    shiftAmount = gmBalance;
  }

  // Execution fee: 0.03 BNB (consistent with GLV operations)
  const executionFee = expandDecimals(3, 16);

  console.log("\nShift Details:");
  console.log("  From Market:", fromMarket);
  console.log("  To Market:", toMarket);
  console.log("  GM Amount to Shift:", ethers.utils.formatEther(shiftAmount), "GM");
  console.log("  Execution Fee:", ethers.utils.formatEther(executionFee), "BNB");

  // Approve Router to spend GM tokens
  const gmAllowance = await gmToken.allowance(wallet.address, router.address);
  if (gmAllowance.lt(shiftAmount)) {
    console.log("\nApproving GM tokens...");
    const approveTx = await gmToken.approve(router.address, ethers.constants.MaxUint256);
    await approveTx.wait();
  }

  // Build Shift params
  // IShiftUtils.CreateShiftParams
  const params = {
    addresses: {
      receiver: wallet.address,
      callbackContract: ethers.constants.AddressZero,
      uiFeeReceiver: ethers.constants.AddressZero,
      fromMarket: fromMarket,
      toMarket: toMarket,
    },
    minMarketTokens: bigNumberify(0), // No minimum, accept any amount
    executionFee: executionFee,
    callbackGasLimit: bigNumberify(0),
    dataList: [],
  };

  console.log("\nCreating shift...");

  // Use multicall to send shift request
  const multicallArgs = [];

  // Send GM tokens to ShiftVault
  multicallArgs.push(
    exchangeRouter.interface.encodeFunctionData("sendTokens", [fromMarket, shiftVault.address, shiftAmount])
  );

  // Send execution fee (BNB)
  multicallArgs.push(exchangeRouter.interface.encodeFunctionData("sendWnt", [shiftVault.address, executionFee]));

  // Create shift
  multicallArgs.push(exchangeRouter.interface.encodeFunctionData("createShift", [params]));

  // Simulate transaction
  console.log("\nSimulating transaction...");
  try {
    await exchangeRouter.callStatic.multicall(multicallArgs, {
      value: executionFee,
      gasLimit: 8000000,
    });
    console.log("Simulation successful");
  } catch (e: any) {
    console.error("Simulation failed:", e.message);
    console.log("\nPossible reasons:");
    console.log("  - GM token balance is 0");
    console.log("  - Markets are not compatible");
    console.log("  - Insufficient execution fee");
    console.log("  - ShiftHandler not configured");
    process.exit(1);
  }

  // Execute transaction
  console.log("\nSending transaction...");
  const tx = await exchangeRouter.multicall(multicallArgs, {
    value: executionFee,
    gasLimit: 8000000,
  });

  console.log("Transaction hash:", tx.hash);
  console.log("Waiting for confirmation...");

  const receipt = await tx.wait();
  console.log("\nTransaction confirmed!");
  console.log("  Block:", receipt.blockNumber);
  console.log("  Gas used:", receipt.gasUsed.toString());
  console.log("  Status:", receipt.status === 1 ? "Success" : "Failed");

  // Query pending shifts count
  const SHIFT_LIST_KEY = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("SHIFT_LIST"));
  const shiftCount = await dataStore.getBytes32Count(SHIFT_LIST_KEY);
  console.log("\nTotal pending shifts:", shiftCount.toString());

  console.log("\n=== Shift request created successfully! ===");
  console.log("The shift will be executed by a keeper.");
  console.log("\nAfter execution:");
  console.log("  - Your GM tokens from", fromMarket.slice(0, 10) + "...", "will be burned");
  console.log("  - You will receive GM tokens from", toMarket.slice(0, 10) + "...");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
