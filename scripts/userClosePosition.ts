import hre from "hardhat";
import { bigNumberify, expandDecimals, decimalToFloat } from "../utils/math";
import { ExchangeRouter, MintableToken } from "../typechain-types";
import { OrderUtils } from "../typechain-types/contracts/exchange/OrderHandler";

const { ethers, deployments } = hre as any;

/**
 * User Close Position Script (Full Close)
 * Close an entire position
 *
 * Environment Variables:
 *   MARKET_ADDRESS: Market address (required)
 *   IS_LONG: Position direction (optional, default true)
 *   SIZE_USD: Full position size in USD to close (required for full close, or use CLOSE_ALL=true)
 *   CLOSE_ALL: If true, will attempt to close maximum position (optional)
 *
 * Order type: MarketDecrease (4) - Market order to decrease position
 * Note: For full close, sizeDeltaUsd should equal the full position size
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

// Get position key
function getPositionKey(account: string, market: string, collateralToken: string, isLong: boolean): string {
  return ethers.utils.solidityKeccak256(
    ["address", "address", "address", "bool"],
    [account, market, collateralToken, isLong]
  );
}

async function main() {
  const [wallet] = await ethers.getSigners();
  console.log("Wallet address:", wallet.address);
  console.log("Wallet balance:", ethers.utils.formatEther(await wallet.getBalance()), "BNB");

  // Get contract instances
  const exchangeRouter: ExchangeRouter = await ethers.getContract("ExchangeRouter");
  const orderVault = await ethers.getContract("OrderVault");
  const dataStore = await ethers.getContract("DataStore");
  const reader = await ethers.getContract("Reader");

  console.log("\nContract addresses:");
  console.log("  ExchangeRouter:", exchangeRouter.address);
  console.log("  OrderVault:", orderVault.address);

  // Get Market address
  const marketAddress = process.env.MARKET_ADDRESS;
  if (!marketAddress) {
    console.error("\nError: MARKET_ADDRESS environment variable is required");
    console.log("\nUsage: MARKET_ADDRESS=0x... IS_LONG=true make user-close");
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
  const collateralDecimals = isLong ? marketTokens.longDecimals : marketTokens.shortDecimals;

  // Get WNT address
  const wntAddress = await getWntAddress();
  const isCollateralWnt = collateralTokenAddress.toLowerCase() === wntAddress.toLowerCase();

  // Try to get current position size
  const positionKey = getPositionKey(wallet.address, marketAddress, collateralTokenAddress, isLong);
  console.log("  Position Key:", positionKey);

  let sizeDeltaUsd;
  let positionSizeUsd = 0;

  try {
    const position = await reader.getPosition(dataStore.address, positionKey);
    positionSizeUsd = parseFloat(ethers.utils.formatUnits(position.sizeInUsd, 30));
    console.log("\nCurrent Position:");
    console.log("  Size in USD:", positionSizeUsd.toLocaleString());
    console.log("  Collateral:", ethers.utils.formatUnits(position.collateralAmount, collateralDecimals));
    console.log("  Is Long:", position.isLong);

    if (position.sizeInUsd.eq(0)) {
      console.error("\nError: No position found to close!");
      console.log("Please open a position first using 'make user-market-long' or 'make user-market-short'");
      process.exit(1);
    }

    // Use full position size for closing
    sizeDeltaUsd = position.sizeInUsd;
  } catch (e) {
    console.log("\nWarning: Could not fetch position from chain");
    // Fall back to SIZE_USD parameter
    const sizeUsd = process.env.SIZE_USD ? parseInt(process.env.SIZE_USD) : 200000;
    sizeDeltaUsd = decimalToFloat(sizeUsd);
    positionSizeUsd = sizeUsd;
    console.log("Using SIZE_USD parameter:", sizeUsd.toLocaleString(), "USD");
  }

  // Execution fee: 0.02 BNB
  const executionFee = expandDecimals(2, 16);

  // Acceptable price for closing
  // For LONG close: min price we accept (we're selling)
  // For SHORT close: max price we accept (we're buying back)
  const acceptablePrice = isLong
    ? expandDecimals(4900, 12) // $4900 min for closing long
    : expandDecimals(5100, 12); // $5100 max for closing short

  console.log("\nClose Order Details:");
  console.log("  Order Type: MarketDecrease (Full Close)");
  console.log("  Direction:", isLong ? "LONG" : "SHORT");
  console.log("  Size to Close:", positionSizeUsd.toLocaleString(), "USD (100%)");
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
      initialCollateralDeltaAmount: bigNumberify(0), // Let system calculate
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
    shouldUnwrapNativeToken: isCollateralWnt, // Unwrap WNT to BNB if applicable
    autoCancel: false,
    referralCode: ethers.constants.HashZero,
    dataList: [], // Required by contract - empty array for no additional data
  };

  console.log("\nCreating full close order...");

  // Use multicall to send order request
  const multicallArgs = [];

  // Only need to send execution fee
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
    console.log("  - No existing position to close");
    console.log("  - Position already closed");
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

  console.log("\n=== Full Close Order created successfully! ===");
  console.log("The order will be executed by a keeper at current market price.");
  console.log("\nYour entire position will be closed.");
  console.log("You will receive: Full Collateral + PnL (minus fees)");
  console.log("\nPnL Calculation:");
  if (isLong) {
    console.log("  LONG: PnL = (Close Price - Entry Price) x Position Size");
    console.log("  Profit if price went UP since entry");
  } else {
    console.log("  SHORT: PnL = (Entry Price - Close Price) x Position Size");
    console.log("  Profit if price went DOWN since entry");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
