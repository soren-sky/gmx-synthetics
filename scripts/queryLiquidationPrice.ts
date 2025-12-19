import hre from "hardhat";

const { ethers } = hre as any;

/**
 * Query Liquidation Price Comparison Script
 *
 * Compares Redis liquidation price (from Keeper) with on-chain calculated liquidation price
 * Uses binary search to find the exact liquidation price boundary on-chain
 *
 * Environment Variables:
 *   KEEPER_API: Keeper API URL (default: http://localhost:28080)
 *   ACCOUNT: Filter positions by account address (optional, defaults to current wallet)
 */

interface KeeperPosition {
  position_key: string;
  account: string;
  market: string;
  collateral_token: string;
  size_in_usd: string;
  size_in_tokens: string;
  collateral_amount: string;
  is_long: boolean;
  liquidate_price: string; // Note: Keeper uses "liquidate_price" not "liquidation_price"
  average_price: string; // Entry price
  status: string;
  index_token: string;
}

interface KeeperAPIResponse {
  positions?: KeeperPosition[];
  error?: string;
}

async function getDeployment(contractName: string) {
  try {
    return await ethers.getContract(contractName);
  } catch (error: any) {
    if (error?.message?.includes("No Contract deployed with name")) {
      return null;
    }
    throw error;
  }
}

async function getTokenDecimals(tokenAddress: string): Promise<number> {
  try {
    const token = await ethers.getContractAt("IERC20Metadata", tokenAddress);
    return await token.decimals();
  } catch (_e) {
    return 18; // Default fallback
  }
}

async function fetchKeeperPositions(keeperApi: string, account?: string): Promise<KeeperPosition[]> {
  const url = `${keeperApi}/api/v1/bsc/positions?status=Active&limit=100${account ? `&account=${account}` : ""}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data: KeeperAPIResponse = await response.json();
    return data.positions || [];
  } catch (error: any) {
    console.log(`  Warning: Could not fetch from Keeper API: ${error.message}`);
    return [];
  }
}

async function isLiquidatableAtPrice(
  reader: any,
  dataStore: any,
  referralStorage: any,
  positionKey: string,
  market: any,
  priceUsd: number,
  isLong: boolean,
  longTokenDecimals = 18,
  shortTokenDecimals = 18
): Promise<{ isLiquidatable: boolean; reason?: string; info?: any }> {
  // Validate priceUsd
  if (!priceUsd || isNaN(priceUsd) || priceUsd <= 0) {
    return { isLiquidatable: false };
  }

  try {
    // GMX uses price format: price_usd * 10^(30 - tokenDecimals)
    // For a token with 18 decimals: price = price_usd * 10^12
    // For a token with 6 decimals (USDC): price = price_usd * 10^24
    const indexPriceExponent = 30 - longTokenDecimals; // For index/long token
    const shortPriceExponent = 30 - shortTokenDecimals; // For short token (stablecoin)

    // Use parseUnits with string to avoid floating-point precision issues
    const priceStr = priceUsd.toFixed(2); // Keep 2 decimal places
    const indexPrice = ethers.utils.parseUnits(priceStr, indexPriceExponent);

    // Short token (stablecoin) price = $1 * 10^(30 - shortTokenDecimals)
    const stablecoinPrice = ethers.utils.parseUnits("1", shortPriceExponent);

    const prices = {
      indexTokenPrice: { min: indexPrice, max: indexPrice },
      longTokenPrice: { min: indexPrice, max: indexPrice },
      shortTokenPrice: {
        min: stablecoinPrice,
        max: stablecoinPrice,
      },
    };

    const referralAddr = referralStorage ? referralStorage.address : ethers.constants.AddressZero;

    const result = await reader.isPositionLiquidatable(
      dataStore.address,
      referralAddr,
      positionKey,
      market,
      prices,
      true, // shouldValidateMinCollateralUsd
      true // forLiquidation
    );
    // Result is a tuple: [isLiquidatable, reason, liquidationInfo]
    const isLiq = result[0];
    const reason = result[1];
    const info = result[2];

    // Log first call for debugging (verbose mode)
    if (!(isLiquidatableAtPrice as any).firstCallLogged && process.env.VERBOSE) {
      console.log(`    [Debug] Price: ${indexPrice.toString()} (${priceUsd} USD)`);
      console.log(`    [Debug] Result: isLiquidatable=${isLiq}, reason="${reason || "none"}"`);
      if (info) {
        const remaining = info.remainingCollateralUsd || info[0];
        const minCollateral = info.minCollateralUsd || info[1];
        if (remaining) {
          try {
            const remainingFormatted = ethers.utils.formatUnits(remaining, 30);
            console.log(`    [Debug] Remaining collateral: $${parseFloat(remainingFormatted).toFixed(2)}`);
          } catch (e: any) {
            /* ignore */
          }
        }
      }
      (isLiquidatableAtPrice as any).firstCallLogged = true;
    }
    return { isLiquidatable: isLiq, reason, info };
  } catch (e: any) {
    // Log error for debugging (only once)
    if (!(isLiquidatableAtPrice as any).errorLogged) {
      console.log(`    [Debug] isPositionLiquidatable error: ${e.message?.substring(0, 200)}`);
      (isLiquidatableAtPrice as any).errorLogged = true;
    }
    return { isLiquidatable: false };
  }
}

async function binarySearchLiquidationPrice(
  reader: any,
  dataStore: any,
  referralStorage: any,
  positionKey: string,
  market: any,
  isLong: boolean,
  entryPrice: number,
  longTokenDecimals = 18,
  shortTokenDecimals = 18,
  tolerance = 0.01 // $0.01 precision
): Promise<number | null> {
  // For LONG: liquidation happens when price drops
  // For SHORT: liquidation happens when price rises

  let low: number, high: number;

  if (isLong) {
    // Long: search from 0 to entry price (price dropping causes liquidation)
    low = entryPrice * 0.5; // Start at 50% of entry
    high = entryPrice * 1.1; // Allow some buffer above entry
  } else {
    // Short: search from entry price upward (price rising causes liquidation)
    low = entryPrice * 0.9; // Start slightly below entry
    high = entryPrice * 2.0; // Up to 2x entry price
  }

  if (process.env.VERBOSE) {
    console.log(`    [Debug] Entry: $${entryPrice.toFixed(2)}, Search range: $${low.toFixed(2)} - $${high.toFixed(2)}`);
  }

  // First, verify we can find boundaries
  const resultLow = await isLiquidatableAtPrice(
    reader,
    dataStore,
    referralStorage,
    positionKey,
    market,
    low,
    isLong,
    longTokenDecimals,
    shortTokenDecimals
  );
  const resultHigh = await isLiquidatableAtPrice(
    reader,
    dataStore,
    referralStorage,
    positionKey,
    market,
    high,
    isLong,
    longTokenDecimals,
    shortTokenDecimals
  );

  if (process.env.VERBOSE) {
    console.log(`    [Debug] At $${low.toFixed(2)}: ${resultLow.isLiquidatable ? "LIQUIDATABLE" : "SAFE"}`);
    console.log(`    [Debug] At $${high.toFixed(2)}: ${resultHigh.isLiquidatable ? "LIQUIDATABLE" : "SAFE"}`);
  }

  if (isLong) {
    // For LONG: should be liquidatable at low price, not at high price
    if (!resultLow.isLiquidatable && !resultHigh.isLiquidatable) {
      // Try lower prices
      low = entryPrice * 0.1;
      const resultVeryLow = await isLiquidatableAtPrice(
        reader,
        dataStore,
        referralStorage,
        positionKey,
        market,
        low,
        isLong,
        longTokenDecimals,
        shortTokenDecimals
      );
      if (process.env.VERBOSE) {
        console.log(`    [Debug] At $${low.toFixed(2)}: ${resultVeryLow.isLiquidatable ? "LIQUIDATABLE" : "SAFE"}`);
      }
      if (!resultVeryLow.isLiquidatable) {
        return null; // Cannot find liquidation boundary - position very safe
      }
    }
    if (resultLow.isLiquidatable && resultHigh.isLiquidatable) {
      // Position is already liquidatable at current price
      return high;
    }
  } else {
    // For SHORT: should be liquidatable at high price, not at low price
    if (!resultLow.isLiquidatable && !resultHigh.isLiquidatable) {
      // Try higher prices
      high = entryPrice * 5.0;
      const resultVeryHigh = await isLiquidatableAtPrice(
        reader,
        dataStore,
        referralStorage,
        positionKey,
        market,
        high,
        isLong,
        longTokenDecimals,
        shortTokenDecimals
      );
      if (process.env.VERBOSE) {
        console.log(`    [Debug] At $${high.toFixed(2)}: ${resultVeryHigh.isLiquidatable ? "LIQUIDATABLE" : "SAFE"}`);
      }
      if (!resultVeryHigh.isLiquidatable) {
        return null; // Cannot find liquidation boundary
      }
    }
    if (resultLow.isLiquidatable && resultHigh.isLiquidatable) {
      return low;
    }
  }

  // Binary search
  let iterations = 0;
  const maxIterations = 50;

  while (high - low > tolerance && iterations < maxIterations) {
    const mid = (low + high) / 2;
    const resultMid = await isLiquidatableAtPrice(
      reader,
      dataStore,
      referralStorage,
      positionKey,
      market,
      mid,
      isLong,
      longTokenDecimals,
      shortTokenDecimals
    );

    if (isLong) {
      // For LONG: liquidatable when price is LOW
      if (resultMid.isLiquidatable) {
        low = mid; // Move up to find the boundary
      } else {
        high = mid; // Move down
      }
    } else {
      // For SHORT: liquidatable when price is HIGH
      if (resultMid.isLiquidatable) {
        high = mid; // Move down to find the boundary
      } else {
        low = mid; // Move up
      }
    }

    iterations++;
  }

  return isLong ? low : high;
}

async function main() {
  const keeperApi = process.env.KEEPER_API || "http://localhost:28080";
  const [wallet] = await ethers.getSigners();
  const accountFilter = process.env.ACCOUNT || wallet.address;

  console.log("");
  console.log("  ╔════════════════════════════════════════════════════════════════════════╗");
  console.log("  ║                     清算价格对比查询                                    ║");
  console.log("  ╠════════════════════════════════════════════════════════════════════════╣");
  console.log(`  ║  Keeper API: ${keeperApi.padEnd(56)}║`);
  console.log(`  ║  Account:    ${accountFilter.substring(0, 42).padEnd(56)}║`);
  console.log("  ╚════════════════════════════════════════════════════════════════════════╝");
  console.log("");

  // Get contract instances
  const reader = await getDeployment("Reader");
  const dataStore = await getDeployment("DataStore");
  const referralStorage = await getDeployment("ReferralStorage");

  if (!reader || !dataStore) {
    console.log("  ERROR: Reader or DataStore not deployed.");
    process.exit(1);
  }

  // Fetch positions from Keeper API
  console.log("  Fetching positions from Keeper...");
  const positions = await fetchKeeperPositions(keeperApi, accountFilter);

  if (positions.length === 0) {
    console.log("");
    console.log("  No active positions found.");
    console.log("");
    console.log("  Tips:");
    console.log("    1. Make sure Keeper is running at " + keeperApi);
    console.log("    2. Create a position with: make user-market-long");
    console.log("    3. Or query all positions: curl " + keeperApi + "/api/v1/bsc/positions?status=Active");
    return;
  }

  console.log(`  Found ${positions.length} active position(s)\n`);

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const positionKey = pos.position_key;

    console.log("  ────────────────────────────────────────────────────────────────────────");
    console.log(
      `  Position #${i + 1}: ${positionKey.substring(0, 18)}...${positionKey.substring(positionKey.length - 8)}`
    );
    console.log("  ────────────────────────────────────────────────────────────────────────");

    // Get position from chain
    let chainPosition: any;
    try {
      chainPosition = await reader.getPosition(dataStore.address, positionKey);
    } catch (e: any) {
      console.log(`    Error reading position from chain: ${e.message}`);
      continue;
    }

    // Position.Props has nested structure: addresses, numbers, flags
    // ethers.js may return it as nested or flattened - handle both
    const account = chainPosition.addresses?.account || chainPosition.account;
    const marketAddr = chainPosition.addresses?.market || chainPosition.market;
    // For isLong, also use Keeper data as fallback
    const isLong = chainPosition.flags?.isLong ?? chainPosition.isLong ?? pos.is_long;
    const sizeInUsd = chainPosition.numbers?.sizeInUsd || chainPosition.sizeInUsd;
    const sizeInTokens = chainPosition.numbers?.sizeInTokens || chainPosition.sizeInTokens;

    if (!account || account === ethers.constants.AddressZero) {
      console.log("    Status: Position not found on chain (may be closed)");
      continue;
    }

    // Use Keeper data for size (it's already parsed)
    const sizeUsd = parseFloat(pos.size_in_usd || "0") / 1e30;

    // Get market info and token decimals for price calculation
    const market = await reader.getMarket(dataStore.address, marketAddr || pos.market);
    const longTokenDecimals = await getTokenDecimals(market.longToken);
    const shortTokenDecimals = await getTokenDecimals(market.shortToken);

    // Parse Redis liquidation price (Keeper uses "liquidate_price" field)
    const redisLiqPrice = parseFloat(pos.liquidate_price || "0");

    // Get entry price from Keeper's average_price field (most accurate)
    // average_price is stored as price * 10^12 format (GMX price format)
    let entryPrice: number;
    const avgPriceRaw = parseFloat(pos.average_price || "0");
    if (avgPriceRaw > 0) {
      entryPrice = avgPriceRaw / 1e12; // Convert from 10^12 format
    } else {
      // Fallback: calculate from size
      const sizeInTokensNum = parseFloat(pos.size_in_tokens || "0") / 1e18;
      if (sizeInTokensNum > 0 && sizeUsd > 0) {
        entryPrice = sizeUsd / sizeInTokensNum;
      } else if (redisLiqPrice > 0) {
        entryPrice = isLong ? redisLiqPrice * 1.1 : redisLiqPrice * 0.9;
      } else {
        entryPrice = 100000; // Default for BTC
      }
    }

    // Display position info
    console.log(`    Direction:  ${isLong ? "LONG" : "SHORT"}`);
    console.log(
      `    Size:       $${sizeUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    );
    console.log(
      `    Entry:      $${entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    );
    console.log("");

    // Get Redis liquidation price
    if (redisLiqPrice > 0) {
      console.log(
        `    Redis Liq Price:  $${redisLiqPrice.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`
      );
    } else {
      console.log(`    Redis Liq Price:  N/A (Keeper hasn't calculated yet)`);
    }

    // Binary search for chain liquidation price
    // Use percentage-based tolerance (0.01% of entry price)
    const tolerance = Math.max(entryPrice * 0.0001, 1); // 0.01% precision, min $1
    console.log("    Calculating chain liquidation price (binary search)...");

    // Validate before calling binary search
    if (!entryPrice || entryPrice <= 0) {
      console.log(`    Chain Liq Price:  Unable to calculate (invalid entry price)`);
      console.log(`    Status:           ⚠️  Could not estimate entry price`);
      continue;
    }

    const chainLiqPrice = await binarySearchLiquidationPrice(
      reader,
      dataStore,
      referralStorage,
      positionKey,
      market,
      isLong,
      entryPrice,
      longTokenDecimals,
      shortTokenDecimals,
      tolerance
    );

    if (chainLiqPrice === null) {
      console.log(`    Chain Liq Price:  Unable to calculate`);
      console.log(`    Status:           ⚠️  Could not determine liquidation boundary`);
    } else {
      const chainLiqPriceFormatted = chainLiqPrice.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      console.log(`    Chain Liq Price:  $${chainLiqPriceFormatted}`);

      // Show liquidation boundary explanation
      console.log("");
      console.log("    Liquidation Boundary (via isPositionLiquidatable):");
      if (isLong) {
        console.log(`      • Price < $${chainLiqPriceFormatted} → LIQUIDATABLE`);
        console.log(`      • Price ≥ $${chainLiqPriceFormatted} → SAFE`);
      } else {
        console.log(`      • Price > $${chainLiqPriceFormatted} → LIQUIDATABLE`);
        console.log(`      • Price ≤ $${chainLiqPriceFormatted} → SAFE`);
      }
      console.log("");

      if (redisLiqPrice > 0) {
        const diff = Math.abs(chainLiqPrice - redisLiqPrice);
        const diffPercent = (diff / redisLiqPrice) * 100;

        console.log(
          `    Difference:       $${diff.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })} (${diffPercent.toFixed(4)}%)`
        );

        if (diffPercent < 0.1) {
          console.log(`    Status:           ✅ Match (< 0.1% diff)`);
        } else if (diffPercent < 1) {
          console.log(`    Status:           ⚠️  Minor difference (< 1%)`);
        } else {
          console.log(`    Status:           ❌ Significant difference (> 1%)`);
        }
      } else {
        console.log(`    Status:           ℹ️  Redis price not available for comparison`);
      }
    }
    console.log("");
  }

  console.log("  ════════════════════════════════════════════════════════════════════════");
  console.log("  Query complete.");
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
