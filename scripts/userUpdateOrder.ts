import hre from "hardhat";
import { bigNumberify, expandDecimals } from "../utils/math";
import { ExchangeRouter } from "../typechain-types";
import * as http from "http";

const { ethers } = hre as any;

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

// Fetch order from keeper debug API
interface KeeperOrder {
  order_key: string;
  account: string;
  market: string;
  order_type: number;
  size_delta_usd: string;
  trigger_price: string;
  acceptable_price: string;
  is_long: boolean;
  status: string;
}

async function getOrderFromKeeper(orderKey: string): Promise<KeeperOrder | null> {
  try {
    const url = `${KEEPER_API_URL}/api/v1/bsc/order/${orderKey}`;
    const responseText = await httpGet(url);
    const data = JSON.parse(responseText);
    return data.order || data;
  } catch (e: any) {
    console.log("  Note: Could not fetch order from keeper API:", e.message);
    return null;
  }
}

// Get order type name
function getOrderTypeName(orderType: number): string {
  const types: { [key: number]: string } = {
    0: "MarketSwap",
    1: "LimitSwap",
    2: "MarketIncrease",
    3: "LimitIncrease",
    4: "MarketDecrease",
    5: "LimitDecrease",
    6: "StopLossDecrease",
    7: "Liquidation",
  };
  return types[orderType] || `Unknown(${orderType})`;
}

/**
 * User Update Order Script
 * Update an existing limit order (modify trigger price, size, etc.)
 *
 * Environment Variables:
 *   ORDER_KEY: Order key to update (required)
 *   TRIGGER_PRICE: New trigger price in USD (optional)
 *   SIZE_USD: New position size in USD (optional, 0 = keep current)
 *   ACCEPTABLE_PRICE: New acceptable price (optional, auto-calculated from trigger)
 *
 * Note: Only non-market orders can be updated (LimitIncrease, LimitDecrease, StopLossDecrease)
 */

async function main() {
  const [wallet] = await ethers.getSigners();
  console.log("Wallet address:", wallet.address);
  console.log("Wallet balance:", ethers.utils.formatEther(await wallet.getBalance()), "BNB");

  // Get contract instances
  const exchangeRouter: ExchangeRouter = await ethers.getContract("ExchangeRouter");
  const dataStore = await ethers.getContract("DataStore");

  console.log("\nContract addresses:");
  console.log("  ExchangeRouter:", exchangeRouter.address);

  // Get Order key
  const orderKey = process.env.ORDER_KEY;
  if (!orderKey) {
    console.error("\nError: ORDER_KEY environment variable is required");
    console.log("\nUsage: ORDER_KEY=0x... TRIGGER_PRICE=85000 make user-update-order");
    console.log("\nTo find order keys, check keeper logs or use the debug API:");
    console.log("  curl http://localhost:28080/api/v1/bsc/orders?account=" + wallet.address);
    process.exit(1);
  }

  console.log("\n  Order Key:", orderKey);

  // Try to fetch current order info from keeper
  const keeperOrder = await getOrderFromKeeper(orderKey);

  let currentTriggerPrice = bigNumberify(0);
  let currentSizeUsd = bigNumberify(0);
  let currentAcceptablePrice = bigNumberify(0);
  let orderType = 0;
  let isLong = true;

  if (keeperOrder) {
    currentTriggerPrice = ethers.BigNumber.from(keeperOrder.trigger_price || "0");
    currentSizeUsd = ethers.BigNumber.from(keeperOrder.size_delta_usd || "0");
    currentAcceptablePrice = ethers.BigNumber.from(keeperOrder.acceptable_price || "0");
    orderType = keeperOrder.order_type;
    isLong = keeperOrder.is_long;

    console.log("\nCurrent Order (from keeper DB):");
    console.log("  Order Type:", getOrderTypeName(orderType));
    console.log("  Direction:", isLong ? "LONG" : "SHORT");
    console.log("  Size USD:", ethers.utils.formatUnits(currentSizeUsd, 30));
    console.log("  Trigger Price:", ethers.utils.formatUnits(currentTriggerPrice, 12), "USD");
    console.log("  Acceptable Price:", ethers.utils.formatUnits(currentAcceptablePrice, 12), "USD");
    console.log("  Status:", keeperOrder.status);

    // Validate order type (can only update limit orders)
    if (orderType === 2 || orderType === 4) {
      console.error("\nError: Cannot update market orders (type 2 or 4)");
      console.error("Only limit orders can be updated (LimitIncrease, LimitDecrease, StopLossDecrease)");
      process.exit(1);
    }
  } else {
    console.log("\n  Could not fetch order details from keeper. Proceeding with provided values...");
  }

  // Parse new values
  // TRIGGER_PRICE: New trigger price (required for update)
  const newTriggerPriceUsd = process.env.TRIGGER_PRICE ? parseFloat(process.env.TRIGGER_PRICE) : 0;
  if (newTriggerPriceUsd === 0) {
    console.error("\nError: TRIGGER_PRICE is required for update");
    console.log("\nUsage: ORDER_KEY=0x... TRIGGER_PRICE=85000 make user-update-order");
    process.exit(1);
  }
  const newTriggerPrice = expandDecimals(Math.floor(newTriggerPriceUsd), 12);

  // SIZE_USD: New size (if not specified, use current size from keeper)
  // IMPORTANT: GMX contract does NOT treat 0 as "keep current" - it directly sets the value
  // We must pass the actual current sizeDeltaUsd if user wants to keep it unchanged
  let newSizeDeltaUsd;
  if (process.env.SIZE_USD) {
    const newSizeUsd = parseInt(process.env.SIZE_USD);
    newSizeDeltaUsd = expandDecimals(newSizeUsd, 30);
  } else if (currentSizeUsd.gt(0)) {
    // Use current size from keeper
    newSizeDeltaUsd = currentSizeUsd;
    console.log("  Using current size from order:", ethers.utils.formatUnits(currentSizeUsd, 30), "USD");
  } else {
    console.error("\nError: Could not determine order size. Please specify SIZE_USD.");
    console.log("\nUsage: ORDER_KEY=0x... TRIGGER_PRICE=85000 SIZE_USD=500 make user-update-order");
    process.exit(1);
  }

  // ACCEPTABLE_PRICE: Auto-calculate based on order type and trigger price
  // For LimitIncrease (LONG): acceptablePrice = triggerPrice * 1.02 (max price after trigger)
  // For LimitIncrease (SHORT): acceptablePrice = triggerPrice * 0.98 (min price after trigger)
  // For LimitDecrease/StopLoss (LONG): acceptablePrice = triggerPrice * 0.98 (min price)
  // For LimitDecrease/StopLoss (SHORT): acceptablePrice = triggerPrice * 1.02 (max price)
  let newAcceptablePrice;
  if (process.env.ACCEPTABLE_PRICE) {
    newAcceptablePrice = expandDecimals(Math.floor(parseFloat(process.env.ACCEPTABLE_PRICE)), 12);
  } else {
    // Auto-calculate with 2% slippage
    const isIncreaseOrder = orderType === 3; // LimitIncrease
    if (isIncreaseOrder) {
      // Increase order: for LONG max price, for SHORT min price
      const multiplier = isLong ? 1.02 : 0.98;
      newAcceptablePrice = expandDecimals(Math.floor(newTriggerPriceUsd * multiplier), 12);
    } else {
      // Decrease order: for LONG min price, for SHORT max price
      const multiplier = isLong ? 0.98 : 1.02;
      newAcceptablePrice = expandDecimals(Math.floor(newTriggerPriceUsd * multiplier), 12);
    }
  }

  // Other parameters (keep defaults)
  const minOutputAmount = bigNumberify(0);
  const validFromTime = bigNumberify(0);
  const autoCancel = false;

  console.log("\nUpdate Details:");
  console.log("  New Trigger Price: $" + newTriggerPriceUsd.toLocaleString());
  if (currentTriggerPrice.gt(0)) {
    const oldPrice = parseFloat(ethers.utils.formatUnits(currentTriggerPrice, 12));
    const change = (((newTriggerPriceUsd - oldPrice) / oldPrice) * 100).toFixed(2);
    console.log("    (Change: " + change + "%)");
  }
  console.log(
    "  New Acceptable Price: $" + parseFloat(ethers.utils.formatUnits(newAcceptablePrice, 12)).toLocaleString()
  );
  console.log(
    "  New Size USD:",
    process.env.SIZE_USD
      ? process.env.SIZE_USD
      : "(using current: " + ethers.utils.formatUnits(newSizeDeltaUsd, 30) + ")"
  );

  console.log("\nUpdating order...");

  // Call updateOrder
  try {
    const tx = await exchangeRouter.updateOrder(
      orderKey,
      newSizeDeltaUsd,
      newAcceptablePrice,
      newTriggerPrice,
      minOutputAmount,
      validFromTime,
      autoCancel,
      { gasLimit: 500000 }
    );

    console.log("Transaction hash:", tx.hash);
    console.log("Waiting for confirmation...");

    const receipt = await tx.wait();
    console.log("\nTransaction confirmed!");
    console.log("  Block:", receipt.blockNumber);
    console.log("  Gas used:", receipt.gasUsed.toString());
    console.log("  Status:", receipt.status === 1 ? "Success" : "Failed");

    console.log("\n=== Order updated successfully! ===");
    console.log("\nNew trigger price: $" + newTriggerPriceUsd.toLocaleString());
    console.log("The order will now trigger at the new price.");
  } catch (e: any) {
    console.error("\nUpdate failed:", e.message);
    console.log("\nPossible reasons:");
    console.log("  - Order does not exist or already executed/cancelled");
    console.log("  - You are not the owner of this order");
    console.log("  - Market orders cannot be updated");
    console.log("  - updateOrder feature is disabled for this order type");
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
