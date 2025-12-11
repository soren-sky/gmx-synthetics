import hre from "hardhat";
import { bigNumberify, expandDecimals, decimalToFloat } from "../utils/math";
import { ExchangeRouter, MintableToken } from "../typechain-types";
import { OrderUtils } from "../typechain-types/contracts/exchange/OrderHandler";

const { ethers, deployments } = hre as any;

/**
 * User Market Long Script
 * Create a market long order (open long position)
 *
 * Environment Variables:
 *   MARKET_ADDRESS: Market address (required)
 *   SIZE_USD: Position size in USD (optional, default 200000)
 *   COLLATERAL_AMOUNT: Collateral amount in ETH (optional, default 10)
 *   LEVERAGE: Leverage multiplier (optional, ignored if COLLATERAL_AMOUNT is set)
 *
 * Order type: MarketIncrease (2) - Market order to increase/open position
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

// WNT key in DataStore (keccak256("WNT"))
const WNT_KEY = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("WNT"));

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

async function getWntAddress(): Promise<string> {
  // 1. Environment variable override
  if (process.env.WBNB_ADDRESS) {
    return process.env.WBNB_ADDRESS;
  }

  // 2. Try to get from DataStore (most reliable after redeployment)
  try {
    const dataStore = await ethers.getContract("DataStore");
    const wntAddress = await dataStore.getAddress(WNT_KEY);
    if (wntAddress && wntAddress !== ethers.constants.AddressZero) {
      return wntAddress;
    }
  } catch (_e) {
    // DataStore not available, try deployments
  }

  // 3. Try to get from deployments
  try {
    const wbnb = await deployments.get("WBNB");
    return wbnb.address;
  } catch (_e) {
    // WBNB not deployed, use fallback
  }

  // 4. Fallback (last resort)
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
  console.log("  Router:", router.address);
  console.log("  OrderVault:", orderVault.address);

  // Get Market address
  const marketAddress = process.env.MARKET_ADDRESS;
  if (!marketAddress) {
    console.error("\nError: MARKET_ADDRESS environment variable is required");
    console.log("\nUsage: MARKET_ADDRESS=0x... make user-market-long");
    process.exit(1);
  }
  console.log("  Market:", marketAddress);

  // Get market tokens with decimals (dynamic)
  const marketTokens = await getMarketTokens(marketAddress);
  const longTokenAddress = marketTokens.longToken;
  const longTokenDecimals = marketTokens.longTokenDecimals;

  // Get WNT address (dynamic from DataStore)
  const wntAddress = await getWntAddress();
  const isLongTokenWnt = longTokenAddress.toLowerCase() === wntAddress.toLowerCase();
  console.log("  Long token is WNT:", isLongTokenWnt);

  // Parse parameters
  // SIZE_USD: Position size in USD (default $10 for small pools)
  const sizeUsd = process.env.SIZE_USD ? parseInt(process.env.SIZE_USD) : 10;
  const sizeDeltaUsd = decimalToFloat(sizeUsd);

  // COLLATERAL_AMOUNT: Collateral in long token units (default 0.0005 BTCB ~ $45)
  const collateralUnits = process.env.COLLATERAL_AMOUNT ? parseFloat(process.env.COLLATERAL_AMOUNT) : 0.0005;
  // Use dynamic decimals from token contract
  const collateralAmount = ethers.utils.parseUnits(collateralUnits.toString(), longTokenDecimals);

  // Execution fee: 0.02 BNB
  const executionFee = expandDecimals(2, 16);

  // Acceptable price: Set high to allow any price for market order
  // For LONG: max price we're willing to pay (set very high for market orders)
  const acceptablePrice = expandDecimals(200000, 12); // $200,000 max (works for BTC ~$90k)

  console.log("\nOrder Details:");
  console.log("  Order Type: MarketIncrease (Market Long)");
  console.log("  Direction: LONG");
  console.log("  Position Size:", sizeUsd.toLocaleString(), "USD");
  console.log("  Collateral:", collateralUnits, "tokens");
  console.log("  Max Acceptable Price: $200,000");
  console.log("  Execution Fee:", ethers.utils.formatEther(executionFee), "BNB");

  // Get long token contract
  const longToken: MintableToken = await ethers.getContractAt("MintableToken", longTokenAddress);

  // Check and prepare collateral
  const longTokenBalance = await longToken.balanceOf(wallet.address);
  console.log("\nCurrent long token balance:", ethers.utils.formatUnits(longTokenBalance, longTokenDecimals));

  if (isLongTokenWnt && longTokenBalance.lt(collateralAmount)) {
    console.log("Wrapping native token to WNT...");
    const wntAbi = [
      "function deposit() external payable",
      "function withdraw(uint256 amount) external",
      "function balanceOf(address account) external view returns (uint256)",
    ];
    const wntContract = new ethers.Contract(wntAddress, wntAbi, wallet);
    const totalNeeded = collateralAmount.add(executionFee);
    const depositTx = await wntContract.deposit({ value: totalNeeded });
    await depositTx.wait();
    console.log("WNT deposit complete");
  } else if (!isLongTokenWnt && longTokenBalance.lt(collateralAmount)) {
    console.log("Minting long token for testing...");
    try {
      const mintTx = await longToken.mint(wallet.address, collateralAmount);
      await mintTx.wait();
      console.log("Long token minted");
    } catch (e) {
      console.log("Note: Could not mint long token (may not be a MintableToken)");
    }
  }

  // Approve Router
  const longTokenAllowance = await longToken.allowance(wallet.address, router.address);
  if (longTokenAllowance.lt(collateralAmount)) {
    console.log("\nApproving long token...");
    const approveTx = await longToken.approve(router.address, ethers.constants.MaxUint256);
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
      initialCollateralToken: longTokenAddress, // Use long token (ETH) as collateral for long
      swapPath: [],
    },
    numbers: {
      sizeDeltaUsd: sizeDeltaUsd,
      initialCollateralDeltaAmount: collateralAmount,
      triggerPrice: bigNumberify(0), // Market order - no trigger price
      acceptablePrice: acceptablePrice, // Max price for long
      executionFee: executionFee,
      callbackGasLimit: bigNumberify(0),
      minOutputAmount: bigNumberify(0),
      validFromTime: bigNumberify(0),
    },
    orderType: OrderType.MarketIncrease,
    decreasePositionSwapType: 0, // NoSwap
    isLong: true, // LONG position
    shouldUnwrapNativeToken: false,
    autoCancel: false,
    referralCode: ethers.constants.HashZero,
    dataList: [], // Required by contract - empty array for no additional data
  };

  console.log("\nCreating market long order...");

  // Use multicall to send order request
  const multicallArgs = [];

  if (isLongTokenWnt) {
    // Long token is WNT, use sendWnt
    multicallArgs.push(
      exchangeRouter.interface.encodeFunctionData("sendWnt", [orderVault.address, collateralAmount.add(executionFee)])
    );
  } else {
    // Send long token as collateral
    multicallArgs.push(
      exchangeRouter.interface.encodeFunctionData("sendTokens", [
        longTokenAddress,
        orderVault.address,
        collateralAmount,
      ])
    );
    // Send execution fee separately
    multicallArgs.push(exchangeRouter.interface.encodeFunctionData("sendWnt", [orderVault.address, executionFee]));
  }

  // Create order
  multicallArgs.push(exchangeRouter.interface.encodeFunctionData("createOrder", [params]));

  // Calculate total native token needed
  const totalNativeValue = isLongTokenWnt ? collateralAmount.add(executionFee) : executionFee;

  // Simulate transaction first
  console.log("\nSimulating transaction...");
  try {
    await exchangeRouter.callStatic.multicall(multicallArgs, {
      value: totalNativeValue,
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
    value: totalNativeValue,
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

  console.log("\n=== Market Long Order created successfully! ===");
  console.log("The order will be executed by a keeper at current market price.");
  console.log("\nExpected Position:");
  console.log("  Direction: LONG");
  console.log("  Size:", sizeUsd.toLocaleString(), "USD");
  console.log("  Collateral:", collateralUnits, "tokens");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
