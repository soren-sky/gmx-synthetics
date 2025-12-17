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
    const responseText = await httpGet(url);
    const data = JSON.parse(responseText) as { count?: number; positions?: KeeperPosition[] };

    if (!data.positions || data.positions.length === 0) {
      return null;
    }

    // Find matching position by direction
    const position = data.positions.find((p: KeeperPosition) => p.is_long === isLong);
    return position || null;
  } catch (e: any) {
    return null;
  }
}

/**
 * User Increase Position Script
 * Add to an existing position (increase position size)
 *
 * Environment Variables:
 *   MARKET_ADDRESS: Market address (required)
 *   IS_LONG: Position direction (optional, default true)
 *   SIZE_USD: Additional position size in USD (optional, default 500)
 *   COLLATERAL_AMOUNT: Additional collateral (optional, default 0.1 ETH for long, 100 USDC for short)
 *
 * Order type: MarketIncrease (2) - Market order to increase position
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
  const router = await ethers.getContract("Router");
  const orderVault = await ethers.getContract("OrderVault");
  const dataStore = await ethers.getContract("DataStore");

  console.log("\nContract addresses:");
  console.log("  ExchangeRouter:", exchangeRouter.address);
  console.log("  OrderVault:", orderVault.address);

  // Get Market address
  const marketAddress = process.env.MARKET_ADDRESS;
  if (!marketAddress) {
    console.error("\nError: MARKET_ADDRESS environment variable is required");
    console.log("\nUsage: MARKET_ADDRESS=0x... IS_LONG=true SIZE_USD=100000 make user-increase");
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
  const collateralToken: MintableToken = await ethers.getContractAt("MintableToken", collateralTokenAddress);

  // Get WNT address for checking
  const wntAddress = await getWntAddress();
  const isCollateralWnt = collateralTokenAddress.toLowerCase() === wntAddress.toLowerCase();

  // Fetch current position from keeper API (for display)
  const keeperPosition = await getPositionFromKeeper(wallet.address, marketAddress, isLong);

  if (keeperPosition) {
    const currentSizeInUsdBN = ethers.BigNumber.from(keeperPosition.size_in_usd);
    const currentSizeUsd = parseFloat(ethers.utils.formatUnits(currentSizeInUsdBN, 30));

    console.log("\nExisting Position (from keeper DB):");
    console.log("  Position Key:", keeperPosition.position_key);
    console.log("  Current Size:", currentSizeUsd.toLocaleString(), "USD");
    console.log("  Collateral:", ethers.utils.formatUnits(keeperPosition.collateral_amount, collateralDecimals));
  } else {
    console.log("\nNo existing position found - this will create a new position");
  }

  // Parse parameters
  // SIZE_USD: Additional position size in USD (default 10)
  const sizeUsd = process.env.SIZE_USD ? parseInt(process.env.SIZE_USD) : 10;
  const sizeDeltaUsd = decimalToFloat(sizeUsd);

  // COLLATERAL_AMOUNT: Additional collateral
  // If not specified, calculate based on SIZE_USD with ~10x leverage
  // Collateral = SIZE_USD / 10 (in USD terms)
  let collateralAmount;
  const leverage = process.env.LEVERAGE ? parseFloat(process.env.LEVERAGE) : 10;
  const collateralUsd = sizeUsd / leverage;

  if (isLong) {
    // Long token collateral (dynamic decimals)
    // Assume ETH price ~$3000 for rough calculation
    const ethPrice = 3000;
    const defaultCollateralEth = collateralUsd / ethPrice;
    const collateralEth = process.env.COLLATERAL_AMOUNT
      ? parseFloat(process.env.COLLATERAL_AMOUNT)
      : defaultCollateralEth;
    collateralAmount = expandDecimals(Math.floor(collateralEth * 1000000), collateralDecimals - 6);
    console.log(
      "  Additional Collateral:",
      collateralEth.toFixed(6),
      "ETH (~$" + (collateralEth * ethPrice).toFixed(2) + ")"
    );
    console.log("  Target Leverage:", leverage + "x");
  } else {
    // Short token collateral (dynamic decimals)
    const collateralUsdc = process.env.COLLATERAL_AMOUNT ? parseFloat(process.env.COLLATERAL_AMOUNT) : collateralUsd;
    collateralAmount = expandDecimals(Math.floor(collateralUsdc * 1000000), collateralDecimals - 6);
    console.log("  Additional Collateral:", collateralUsdc.toFixed(2), "USDC");
    console.log("  Target Leverage:", leverage + "x");
  }

  // Execution fee: 0.02 BNB
  const executionFee = expandDecimals(2, 16);

  // Acceptable price
  // For LONG: max price we're willing to pay
  // For SHORT: min price we're willing to accept
  // Using wide range for market orders (BTC ~$86,000, allow 20% slippage)
  const acceptablePrice = isLong
    ? expandDecimals(150000, 12) // $150,000 max for long (allows price increase)
    : expandDecimals(50000, 12); // $50,000 min for short (allows price decrease)

  console.log("\nOrder Details:");
  console.log("  Order Type: MarketIncrease (Add to Position)");
  console.log("  Direction:", isLong ? "LONG" : "SHORT");
  console.log("  Additional Size:", sizeUsd.toLocaleString(), "USD");
  console.log("  Acceptable Price:", isLong ? "$150,000 max" : "$50,000 min");
  console.log("  Execution Fee:", ethers.utils.formatEther(executionFee), "BNB");

  // Check and prepare collateral
  const collateralBalance = await collateralToken.balanceOf(wallet.address);
  console.log("\nCurrent collateral balance:", ethers.utils.formatUnits(collateralBalance, collateralDecimals));

  if (isCollateralWnt && collateralBalance.lt(collateralAmount)) {
    console.log("Wrapping BNB to WNT...");
    const wntAbi = [
      "function deposit() external payable",
      "function balanceOf(address account) external view returns (uint256)",
    ];
    const wntContract = new ethers.Contract(wntAddress, wntAbi, wallet);
    const totalNeeded = collateralAmount.add(executionFee);
    const depositTx = await wntContract.deposit({ value: totalNeeded });
    await depositTx.wait();
    console.log("WNT deposit complete");
  } else if (!isCollateralWnt && collateralBalance.lt(collateralAmount)) {
    console.log("Minting collateral token for testing...");
    try {
      const mintTx = await collateralToken.mint(wallet.address, collateralAmount);
      await mintTx.wait();
      console.log("Collateral token minted");
    } catch (e) {
      console.log("Note: Could not mint collateral token");
    }
  }

  // Approve Router
  const collateralAllowance = await collateralToken.allowance(wallet.address, router.address);
  if (collateralAllowance.lt(collateralAmount)) {
    console.log("\nApproving collateral token...");
    const approveTx = await collateralToken.approve(router.address, ethers.constants.MaxUint256);
    await approveTx.wait();
  }

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
      initialCollateralDeltaAmount: collateralAmount,
      triggerPrice: bigNumberify(0),
      acceptablePrice: acceptablePrice,
      executionFee: executionFee,
      callbackGasLimit: bigNumberify(0),
      minOutputAmount: bigNumberify(0),
      validFromTime: bigNumberify(0),
    },
    orderType: OrderType.MarketIncrease,
    decreasePositionSwapType: 0,
    isLong: isLong,
    shouldUnwrapNativeToken: false,
    autoCancel: false,
    referralCode: ethers.constants.HashZero,
    dataList: [], // Required by contract - empty array for no additional data
  };

  console.log("\nCreating increase position order...");

  // Use multicall to send order request
  const multicallArgs = [];

  if (isCollateralWnt) {
    multicallArgs.push(
      exchangeRouter.interface.encodeFunctionData("sendWnt", [orderVault.address, collateralAmount.add(executionFee)])
    );
  } else {
    multicallArgs.push(
      exchangeRouter.interface.encodeFunctionData("sendTokens", [
        collateralTokenAddress,
        orderVault.address,
        collateralAmount,
      ])
    );
    multicallArgs.push(exchangeRouter.interface.encodeFunctionData("sendWnt", [orderVault.address, executionFee]));
  }

  multicallArgs.push(exchangeRouter.interface.encodeFunctionData("createOrder", [params]));

  const totalBnbValue = isCollateralWnt ? collateralAmount.add(executionFee) : executionFee;

  // Simulate transaction
  console.log("\nSimulating transaction...");
  try {
    await exchangeRouter.callStatic.multicall(multicallArgs, {
      value: totalBnbValue,
      gasLimit: 8000000,
    });
    console.log("Simulation successful");
  } catch (e: any) {
    console.error("Simulation failed:", e.message);
    process.exit(1);
  }

  // Execute transaction
  console.log("\nSending transaction...");
  const tx = await exchangeRouter.multicall(multicallArgs, {
    value: totalBnbValue,
    gasLimit: 8000000,
  });

  console.log("Transaction hash:", tx.hash);
  console.log("Waiting for confirmation...");

  const receipt = await tx.wait();
  console.log("\nTransaction confirmed!");
  console.log("  Block:", receipt.blockNumber);
  console.log("  Gas used:", receipt.gasUsed.toString());
  console.log("  Status:", receipt.status === 1 ? "Success" : "Failed");

  console.log("\n=== Increase Position Order created successfully! ===");
  console.log("The order will be executed by a keeper at current market price.");
  console.log("\nYour position will be increased by:", sizeUsd.toLocaleString(), "USD");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
