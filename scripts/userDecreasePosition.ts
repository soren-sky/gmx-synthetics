import hre from "hardhat";
import { bigNumberify, expandDecimals, decimalToFloat } from "../utils/math";
import { ExchangeRouter, MintableToken } from "../typechain-types";
import { OrderUtils } from "../typechain-types/contracts/exchange/OrderHandler";
import * as http from "http";

const { ethers, deployments } = hre as any;

// Keeper debug API configuration
const KEEPER_API_URL = process.env.KEEPER_API_URL || "http://localhost:28080";

// Simple HTTP GET request using native http module
function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve(data));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

// Fetch position from keeper debug API
interface KeeperPosition {
  position_key: string;
  account: string;
  market: string;
  collateral_token: string;
  is_long: boolean;
  size_in_usd: string;
  size_in_tokens: string;
  collateral_amount: string;
  status: string;
}

async function getPositionFromKeeper(account: string, market: string, isLong: boolean): Promise<KeeperPosition | null> {
  try {
    const url = `${KEEPER_API_URL}/api/v1/bsc/positions?account=${account}&market=${market}&status=Active&limit=100`;
    console.log("  Keeper API URL:", url);

    const responseText = await httpGet(url);
    const data = JSON.parse(responseText) as { count?: number; positions?: KeeperPosition[] };

    if (!data.positions || data.positions.length === 0) {
      console.log("  No positions found in keeper DB");
      return null;
    }

    console.log("  Found", data.count || data.positions.length, "position(s) in keeper DB");

    // Find matching position by direction
    const position = data.positions.find((p: KeeperPosition) => p.is_long === isLong);
    return position || null;
  } catch (e: any) {
    console.error("  Failed to fetch from keeper API:", e.message);
    return null;
  }
}

/**
 * User Decrease Position Script (Partial Close)
 * Reduce an existing position size (partial close)
 *
 * Environment Variables:
 *   MARKET_ADDRESS: Market address (required)
 *   IS_LONG: Position direction (optional, default true)
 *   SIZE_USD: Size to close in USD (optional, default 500)
 *   COLLATERAL_DELTA: Collateral to withdraw (optional, default 0 - proportional release)
 *
 * Order type: MarketDecrease (4) - Market order to decrease position
 */

// GMX V2 Order Types
const OrderType = {
  MarketSwap: 0,
  LimitSwap: 1,
  MarketIncrease: 2,
  LimitIncrease: 3,
  MarketDecrease: 4,
  LimitDecrease: 5,
  StopLossDecrease: 6,
  Liquidation: 7,
};

async function getTokenDecimals(tokenAddress: string): Promise<number> {
  try {
    const token = await ethers.getContractAt("IERC20Metadata", tokenAddress);
    return await token.decimals();
  } catch (_e) {
    return 18;
  }
}

async function getMarketTokens(
  marketAddress: string
): Promise<{ longToken: string; shortToken: string; indexToken: string; longDecimals: number; shortDecimals: number }> {
  const reader = await ethers.getContract("Reader");
  const dataStore = await ethers.getContract("DataStore");

  const marketInfo = await reader.getMarket(dataStore.address, marketAddress);

  const longDecimals = await getTokenDecimals(marketInfo.longToken);
  const shortDecimals = await getTokenDecimals(marketInfo.shortToken);

  console.log("\nMarket info from chain:");
  console.log("  Market Token:", marketInfo.marketToken);
  console.log("  Index Token:", marketInfo.indexToken);
  console.log("  Long Token:", marketInfo.longToken);
  console.log("  Short Token:", marketInfo.shortToken);
  console.log("  Long Token Decimals:", longDecimals);
  console.log("  Short Token Decimals:", shortDecimals);

  return {
    longToken: marketInfo.longToken,
    shortToken: marketInfo.shortToken,
    indexToken: marketInfo.indexToken,
    longDecimals,
    shortDecimals,
  };
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
  const orderVault = await ethers.getContract("OrderVault");
  const dataStore = await ethers.getContract("DataStore");

  console.log("\nContract addresses:");
  console.log("  ExchangeRouter:", exchangeRouter.address);
  console.log("  OrderVault:", orderVault.address);

  // Get Market address
  const marketAddress = process.env.MARKET_ADDRESS;
  if (!marketAddress) {
    console.error("\nError: MARKET_ADDRESS environment variable is required");
    console.log("\nUsage: MARKET_ADDRESS=0x... IS_LONG=true SIZE_USD=100000 make user-decrease");
    process.exit(1);
  }
  console.log("  Market:", marketAddress);

  // Get market tokens
  const marketTokens = await getMarketTokens(marketAddress);

  // Parse direction
  const isLong = process.env.IS_LONG !== "false"; // Default to true
  console.log("  Direction:", isLong ? "LONG" : "SHORT");

  // Determine collateral token based on direction
  const collateralTokenAddress = isLong ? marketTokens.longToken : marketTokens.shortToken;

  // Get WNT address
  const wntAddress = await getWntAddress();
  const isCollateralWnt = collateralTokenAddress.toLowerCase() === wntAddress.toLowerCase();

  // Fetch current position from keeper API
  console.log("\n  Fetching position from keeper database...");
  const keeperPosition = await getPositionFromKeeper(wallet.address, marketAddress, isLong);

  if (!keeperPosition) {
    console.error("\nError: No active position found in keeper database!");
    console.error("\nDetails:");
    console.error("  Account:", wallet.address);
    console.error("  Market:", marketAddress);
    console.error("  Direction:", isLong ? "LONG" : "SHORT");
    console.error("\nPossible causes:");
    console.error("  - No position exists for this account/market/direction");
    console.error("  - Position was already closed");
    console.error("  - Keeper service is not running or not synced");
    process.exit(1);
  }

  // Parse current position size from keeper
  const currentSizeInUsdBN = ethers.BigNumber.from(keeperPosition.size_in_usd);
  const currentSizeUsd = parseFloat(ethers.utils.formatUnits(currentSizeInUsdBN, 30));
  const collateralDecimals = isLong ? marketTokens.longDecimals : marketTokens.shortDecimals;

  console.log("\nCurrent Position (from keeper DB):");
  console.log("  Position Key:", keeperPosition.position_key);
  console.log("  Size in USD:", currentSizeUsd.toLocaleString());
  console.log("  Collateral:", ethers.utils.formatUnits(keeperPosition.collateral_amount, collateralDecimals));
  console.log("  Status:", keeperPosition.status);

  // Parse parameters
  // SIZE_USD: Position size to close (default 10)
  const sizeUsd = process.env.SIZE_USD ? parseInt(process.env.SIZE_USD) : 10;

  // Validate SIZE_USD doesn't exceed current position
  if (sizeUsd > currentSizeUsd) {
    console.error("\nError: SIZE_USD exceeds current position size!");
    console.error("  Requested decrease:", sizeUsd.toLocaleString(), "USD");
    console.error("  Current position:", currentSizeUsd.toLocaleString(), "USD");
    console.error("\nTo close the entire position, use: make clean-position-long");
    process.exit(1);
  }

  const sizeDeltaUsd = decimalToFloat(sizeUsd);

  // COLLATERAL_DELTA: Additional collateral to withdraw (default 0 - proportional release)
  const collateralDelta = process.env.COLLATERAL_DELTA ? bigNumberify(process.env.COLLATERAL_DELTA) : bigNumberify(0);

  // Execution fee: 0.02 BNB
  const executionFee = expandDecimals(2, 16);

  // Acceptable price for closing
  // For LONG close: min price we accept (we're selling)
  // For SHORT close: max price we accept (we're buying back)
  // Using wide range for market orders (BTC ~$86,000, allow 20% slippage)
  const acceptablePrice = isLong
    ? expandDecimals(50000, 12) // $50,000 min for closing long (allows price decrease)
    : expandDecimals(150000, 12); // $150,000 max for closing short (allows price increase)

  console.log("\nOrder Details:");
  console.log("  Order Type: MarketDecrease (Partial Close)");
  console.log("  Direction:", isLong ? "LONG" : "SHORT");
  console.log("  Size to Close:", sizeUsd.toLocaleString(), "USD");
  console.log("  Collateral to Withdraw:", collateralDelta.toString(), "(0 = proportional)");
  console.log("  Acceptable Price:", isLong ? "$4,900 min" : "$5,100 max");
  console.log("  Execution Fee:", ethers.utils.formatEther(executionFee), "BNB");

  // Build Order params
  const params: OrderUtils.CreateOrderParamsStruct = {
    addresses: {
      receiver: wallet.address,
      cancellationReceiver: wallet.address,
      callbackContract: ethers.constants.AddressZero,
      uiFeeReceiver: ethers.constants.AddressZero,
      market: marketAddress,
      initialCollateralToken: collateralTokenAddress,
      swapPath: [],
    },
    numbers: {
      sizeDeltaUsd: sizeDeltaUsd,
      initialCollateralDeltaAmount: collateralDelta, // Extra collateral to withdraw
      triggerPrice: bigNumberify(0), // Market order
      acceptablePrice: acceptablePrice,
      executionFee: executionFee,
      callbackGasLimit: bigNumberify(0),
      minOutputAmount: bigNumberify(0),
      validFromTime: bigNumberify(0),
    },
    orderType: OrderType.MarketDecrease,
    decreasePositionSwapType: 0, // NoSwap - receive collateral token
    isLong: isLong,
    shouldUnwrapNativeToken: isCollateralWnt, // Unwrap if collateral is WNT
    autoCancel: false,
    referralCode: ethers.constants.HashZero,
    dataList: [], // Required by contract - empty array for no additional data
  };

  console.log("\nCreating decrease position order...");

  // Use multicall to send order request
  const multicallArgs = [];

  // Only need to send execution fee for decrease orders (no additional collateral needed)
  multicallArgs.push(exchangeRouter.interface.encodeFunctionData("sendWnt", [orderVault.address, executionFee]));

  // Create order
  multicallArgs.push(exchangeRouter.interface.encodeFunctionData("createOrder", [params]));

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
    console.log("  - No existing position to decrease");
    console.log("  - Size to close exceeds position size");
    console.log("  - Insufficient liquidity in market");
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

  // Query pending orders count
  const ORDER_LIST_KEY = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("ORDER_LIST"));
  const orderCount = await dataStore.getBytes32Count(ORDER_LIST_KEY);
  console.log("\nTotal pending orders:", orderCount.toString());

  console.log("\n=== Decrease Position Order created successfully! ===");
  console.log("The order will be executed by a keeper at current market price.");
  console.log("\nYour position will be reduced by:", sizeUsd.toLocaleString(), "USD");
  console.log("You will receive: Collateral + PnL (minus fees)");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
