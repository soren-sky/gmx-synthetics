import hre from "hardhat";
import { bigNumberify, expandDecimals, decimalToFloat } from "../utils/math";
import { ExchangeRouter, MintableToken } from "../typechain-types";
import { OrderUtils } from "../typechain-types/contracts/exchange/OrderHandler";

const { ethers, deployments } = hre as any;

/**
 * User Market Short Script
 * Create a market short order (open short position)
 *
 * Environment Variables:
 *   MARKET_ADDRESS: Market address (required)
 *   SIZE_USD: Position size in USD (optional, default 500)
 *   COLLATERAL_AMOUNT: Collateral amount in USDC (optional, default 100)
 *
 * Order type: MarketIncrease (2) - Market order to increase/open position
 * For SHORT positions, we typically use USDC as collateral
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
    return 18; // Default fallback
  }
}

async function getMarketTokens(marketAddress: string): Promise<{
  longToken: string;
  shortToken: string;
  indexToken: string;
  longTokenDecimals: number;
  shortTokenDecimals: number;
}> {
  const reader = await ethers.getContract("Reader");
  const dataStore = await ethers.getContract("DataStore");

  const marketInfo = await reader.getMarket(dataStore.address, marketAddress);

  // Get decimals dynamically
  const longTokenDecimals = await getTokenDecimals(marketInfo.longToken);
  const shortTokenDecimals = await getTokenDecimals(marketInfo.shortToken);

  console.log("\nMarket info from chain:");
  console.log("  Market Token:", marketInfo.marketToken);
  console.log("  Index Token:", marketInfo.indexToken);
  console.log("  Long Token:", marketInfo.longToken, `(${longTokenDecimals} decimals)`);
  console.log("  Short Token:", marketInfo.shortToken, `(${shortTokenDecimals} decimals)`);

  return {
    longToken: marketInfo.longToken,
    shortToken: marketInfo.shortToken,
    indexToken: marketInfo.indexToken,
    longTokenDecimals,
    shortTokenDecimals,
  };
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
  console.log("  Router:", router.address);
  console.log("  OrderVault:", orderVault.address);

  // Get Market address
  const marketAddress = process.env.MARKET_ADDRESS;
  if (!marketAddress) {
    console.error("\nError: MARKET_ADDRESS environment variable is required");
    console.log("\nUsage: MARKET_ADDRESS=0x... make user-market-short");
    process.exit(1);
  }
  console.log("  Market:", marketAddress);

  // Get market tokens with decimals (dynamic)
  const marketTokens = await getMarketTokens(marketAddress);
  const shortTokenAddress = marketTokens.shortToken;
  const shortTokenDecimals = marketTokens.shortTokenDecimals;

  // Parse parameters
  // SIZE_USD: Position size in USD (default $500 for testnet small pools)
  const sizeUsd = process.env.SIZE_USD ? parseInt(process.env.SIZE_USD) : 500;
  const sizeDeltaUsd = decimalToFloat(sizeUsd);

  // COLLATERAL_AMOUNT: Collateral in short token units (default 100 USDC)
  // Decimals obtained dynamically from token contract
  const collateralUnits = process.env.COLLATERAL_AMOUNT ? parseFloat(process.env.COLLATERAL_AMOUNT) : 100;
  const collateralAmount = ethers.utils.parseUnits(Math.floor(collateralUnits).toString(), shortTokenDecimals);

  // Execution fee: 0.02 BNB
  const executionFee = expandDecimals(2, 16);

  // Acceptable price: Set 2% below current price for slippage protection
  // For SHORT: min price we're willing to accept (we want price to go down)
  const acceptablePrice = expandDecimals(4900, 12); // $4900 min (assuming ~$5000 ETH)

  console.log("\nOrder Details:");
  console.log("  Order Type: MarketIncrease (Market Short)");
  console.log("  Direction: SHORT");
  console.log("  Position Size:", sizeUsd.toLocaleString(), "USD");
  console.log("  Collateral:", collateralUnits.toLocaleString(), "tokens");
  console.log("  Min Acceptable Price: $4,900");
  console.log("  Execution Fee:", ethers.utils.formatEther(executionFee), "BNB");

  // Get short token contract (USDC)
  const shortToken: MintableToken = await ethers.getContractAt("MintableToken", shortTokenAddress);

  // Check and prepare collateral
  const shortTokenBalance = await shortToken.balanceOf(wallet.address);
  console.log("\nCurrent short token balance:", ethers.utils.formatUnits(shortTokenBalance, shortTokenDecimals));

  if (shortTokenBalance.lt(collateralAmount)) {
    console.log("Minting USDC for testing...");
    try {
      const mintTx = await shortToken.mint(wallet.address, collateralAmount);
      await mintTx.wait();
      console.log("USDC minted");
    } catch (e) {
      console.log("Note: Could not mint USDC (may not be a MintableToken)");
      console.log("Please ensure you have enough USDC balance");
    }
  }

  // Approve Router
  const shortTokenAllowance = await shortToken.allowance(wallet.address, router.address);
  if (shortTokenAllowance.lt(collateralAmount)) {
    console.log("\nApproving USDC...");
    const approveTx = await shortToken.approve(router.address, ethers.constants.MaxUint256);
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
      initialCollateralToken: shortTokenAddress, // Use short token (USDC) as collateral for short
      swapPath: [],
    },
    numbers: {
      sizeDeltaUsd: sizeDeltaUsd,
      initialCollateralDeltaAmount: collateralAmount,
      triggerPrice: bigNumberify(0), // Market order - no trigger price
      acceptablePrice: acceptablePrice, // Min price for short
      executionFee: executionFee,
      callbackGasLimit: bigNumberify(0),
      minOutputAmount: bigNumberify(0),
      validFromTime: bigNumberify(0),
    },
    orderType: OrderType.MarketIncrease,
    decreasePositionSwapType: 0, // NoSwap
    isLong: false, // SHORT position
    shouldUnwrapNativeToken: false,
    autoCancel: false,
    referralCode: ethers.constants.HashZero,
    dataList: [], // Required by contract - empty array for no additional data
  };

  console.log("\nCreating market short order...");

  // Use multicall to send order request
  const multicallArgs = [];

  // Send USDC as collateral
  multicallArgs.push(
    exchangeRouter.interface.encodeFunctionData("sendTokens", [shortTokenAddress, orderVault.address, collateralAmount])
  );

  // Send execution fee (BNB)
  multicallArgs.push(exchangeRouter.interface.encodeFunctionData("sendWnt", [orderVault.address, executionFee]));

  // Create order
  multicallArgs.push(exchangeRouter.interface.encodeFunctionData("createOrder", [params]));

  // Simulate transaction first
  console.log("\nSimulating transaction...");
  try {
    await exchangeRouter.callStatic.multicall(multicallArgs, {
      value: executionFee,
      gasLimit: 8000000,
    });
    console.log("Simulation successful");
  } catch (e: any) {
    console.error("Simulation failed:", e.message);
    process.exit(1);
  }

  // Execute actual transaction
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

  console.log("\n=== Market Short Order created successfully! ===");
  console.log("The order will be executed by a keeper at current market price.");
  console.log("\nExpected Position:");
  console.log("  Direction: SHORT");
  console.log("  Size:", sizeUsd.toLocaleString(), "USD");
  console.log("  Collateral:", collateralUnits.toLocaleString(), "tokens");
  console.log("\nNote: You profit when price goes DOWN");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
