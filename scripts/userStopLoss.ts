import hre from "hardhat";
import { bigNumberify, expandDecimals, decimalToFloat } from "../utils/math";
import { ExchangeRouter, MintableToken } from "../typechain-types";
import { OrderUtils } from "../typechain-types/contracts/exchange/OrderHandler";

const { ethers, deployments } = hre as any;

/**
 * User Stop Loss Script
 * Create a stop loss order to limit losses
 *
 * Environment Variables:
 *   MARKET_ADDRESS: Market address (required)
 *   IS_LONG: Position direction (optional, default true)
 *   TRIGGER_PRICE: Price at which to stop loss (optional, default 4500 for long, 5500 for short)
 *   SIZE_USD: Position size to close in USD (optional, default 500)
 *
 * Order type: StopLossDecrease (6) - Stop loss order to decrease/close position
 * Trigger condition:
 *   - For LONG: triggers when price <= triggerPrice (sell to limit loss)
 *   - For SHORT: triggers when price >= triggerPrice (buy back to limit loss)
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
    console.log("\nUsage: MARKET_ADDRESS=0x... TRIGGER_PRICE=4500 make user-stop-loss");
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

  // Parse parameters
  // TRIGGER_PRICE: Price at which to stop loss
  // For LONG: lower than entry to limit loss (default $4500)
  // For SHORT: higher than entry to limit loss (default $5500)
  const defaultTriggerPrice = isLong ? 4500 : 5500;
  const triggerPriceUsd = process.env.TRIGGER_PRICE ? parseFloat(process.env.TRIGGER_PRICE) : defaultTriggerPrice;
  const triggerPrice = expandDecimals(Math.floor(triggerPriceUsd), 12);

  // SIZE_USD: Position size to close (default $500 for testnet)
  const sizeUsd = process.env.SIZE_USD ? parseInt(process.env.SIZE_USD) : 500;
  const sizeDeltaUsd = decimalToFloat(sizeUsd);

  // Execution fee: 0.02 BNB
  const executionFee = expandDecimals(2, 16);

  // Acceptable price after trigger
  // For LONG stop loss: min price we accept (below trigger, allowing some slippage)
  // For SHORT stop loss: max price we accept (above trigger, allowing some slippage)
  const acceptablePrice = isLong
    ? expandDecimals(Math.floor(triggerPriceUsd * 0.95), 12) // 5% below trigger for long (stop loss)
    : expandDecimals(Math.floor(triggerPriceUsd * 1.05), 12); // 5% above trigger for short (stop loss)

  console.log("\nStop Loss Order Details:");
  console.log("  Order Type: StopLossDecrease (Stop Loss)");
  console.log("  Direction:", isLong ? "LONG" : "SHORT");
  console.log("  Trigger Price: $" + triggerPriceUsd.toLocaleString());
  if (isLong) {
    console.log("  Trigger Condition: Price <= $" + triggerPriceUsd.toLocaleString() + " (sell to limit loss)");
    console.log("  Min Acceptable Price: $" + (triggerPriceUsd * 0.95).toLocaleString() + " (5% slippage)");
  } else {
    console.log("  Trigger Condition: Price >= $" + triggerPriceUsd.toLocaleString() + " (buy back to limit loss)");
    console.log("  Max Acceptable Price: $" + (triggerPriceUsd * 1.05).toLocaleString() + " (5% slippage)");
  }
  console.log("  Size to Close:", sizeUsd.toLocaleString(), "USD");
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
      initialCollateralDeltaAmount: bigNumberify(0),
      triggerPrice: triggerPrice,
      acceptablePrice: acceptablePrice,
      executionFee: executionFee,
      callbackGasLimit: bigNumberify(0),
      minOutputAmount: bigNumberify(0),
      validFromTime: bigNumberify(0),
    },
    orderType: OrderType.StopLossDecrease, // Stop loss order
    decreasePositionSwapType: 0, // NoSwap
    isLong: isLong,
    shouldUnwrapNativeToken: isCollateralWnt,
    autoCancel: false,
    referralCode: ethers.constants.HashZero,
    dataList: [], // Required by contract - empty array for no additional data
  };

  console.log("\nCreating stop loss order...");

  // Use multicall to send order request
  const multicallArgs = [];

  // Only need to send execution fee for decrease orders
  multicallArgs.push(exchangeRouter.interface.encodeFunctionData("sendWnt", [orderVault.address, executionFee]));

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
    console.log("\nNote: Stop loss requires an existing position.");
    console.log("Please open a position first using 'make user-market-long' or 'make user-market-short'");
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

  console.log("\n=== Stop Loss Order created successfully! ===");
  console.log("\nOrder will be executed when:");
  if (isLong) {
    console.log("  Price falls to <= $" + triggerPriceUsd.toLocaleString());
    console.log("  Your LONG position will be closed to limit loss");
  } else {
    console.log("  Price rises to >= $" + triggerPriceUsd.toLocaleString());
    console.log("  Your SHORT position will be closed to limit loss");
  }
  console.log("\nThe order is stored on-chain and in Keeper's Redis.");
  console.log("Use 'make user-cancel-order ORDER_KEY=0x...' to cancel.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
