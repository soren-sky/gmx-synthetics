import hre from "hardhat";
import { bigNumberify, expandDecimals, decimalToFloat } from "../utils/math";
import { ExchangeRouter, MintableToken } from "../typechain-types";
import { OrderUtils } from "../typechain-types/contracts/exchange/OrderHandler";

const { ethers, deployments } = hre as any;

/**
 * User Limit Long Script
 * Create a limit long order (buy at lower price)
 *
 * Environment Variables:
 *   MARKET_ADDRESS: Market address (required)
 *   TRIGGER_PRICE: Price at which to trigger the order (optional, default 4800)
 *   SIZE_USD: Position size in USD (optional, default 500)
 *   COLLATERAL_AMOUNT: Collateral amount in ETH (optional, default 0.1)
 *
 * Order type: LimitIncrease (3) - Limit order to open/increase position
 * Trigger condition: For LONG, triggers when price <= triggerPrice (buy low)
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
    console.log("\nUsage: MARKET_ADDRESS=0x... TRIGGER_PRICE=4800 make user-limit-long");
    process.exit(1);
  }
  console.log("  Market:", marketAddress);

  // Get market tokens
  const marketTokens = await getMarketTokens(marketAddress);
  const longTokenAddress = marketTokens.longToken;
  const longDecimals = marketTokens.longDecimals;

  // Get WNT address
  const wntAddress = await getWntAddress();
  const isLongTokenWnt = longTokenAddress.toLowerCase() === wntAddress.toLowerCase();

  // Parse parameters
  // TRIGGER_PRICE: Price at which to trigger (default $4800 - below current ~$5000)
  const triggerPriceUsd = process.env.TRIGGER_PRICE ? parseFloat(process.env.TRIGGER_PRICE) : 4800;
  const triggerPrice = expandDecimals(Math.floor(triggerPriceUsd), 12); // 12 decimals for price

  // SIZE_USD: Position size in USD (default $500 for testnet)
  const sizeUsd = process.env.SIZE_USD ? parseInt(process.env.SIZE_USD) : 500;
  const sizeDeltaUsd = decimalToFloat(sizeUsd);

  // COLLATERAL_AMOUNT: Collateral in long token (default 0.1 ETH for testnet)
  const collateralEth = process.env.COLLATERAL_AMOUNT ? parseFloat(process.env.COLLATERAL_AMOUNT) : 0.1;
  const collateralAmount = expandDecimals(Math.floor(collateralEth * 1000), longDecimals - 3);

  // Execution fee: 0.02 BNB
  const executionFee = expandDecimals(2, 16);

  // Acceptable price: For limit long, set slightly above trigger (max price after trigger)
  // This protects against slippage after the trigger condition is met
  const acceptablePrice = expandDecimals(Math.floor(triggerPriceUsd * 1.02), 12); // 2% above trigger

  console.log("\nLimit Order Details:");
  console.log("  Order Type: LimitIncrease (Limit Long)");
  console.log("  Direction: LONG");
  console.log("  Trigger Price: $" + triggerPriceUsd.toLocaleString());
  console.log("  Trigger Condition: Price <= $" + triggerPriceUsd.toLocaleString());
  console.log("  Position Size:", sizeUsd.toLocaleString(), "USD");
  console.log("  Collateral:", collateralEth, "ETH");
  console.log("  Max Acceptable Price: $" + (triggerPriceUsd * 1.02).toLocaleString());
  console.log("  Execution Fee:", ethers.utils.formatEther(executionFee), "BNB");

  // Get long token contract
  const longToken: MintableToken = await ethers.getContractAt("MintableToken", longTokenAddress);

  // Check and prepare collateral
  const longTokenBalance = await longToken.balanceOf(wallet.address);
  console.log("\nCurrent long token balance:", ethers.utils.formatUnits(longTokenBalance, longDecimals));

  if (isLongTokenWnt && longTokenBalance.lt(collateralAmount)) {
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
  } else if (!isLongTokenWnt && longTokenBalance.lt(collateralAmount)) {
    console.log("Minting long token for testing...");
    try {
      const mintTx = await longToken.mint(wallet.address, collateralAmount);
      await mintTx.wait();
      console.log("Long token minted");
    } catch (e) {
      console.log("Note: Could not mint long token");
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
      initialCollateralToken: longTokenAddress,
      swapPath: [],
    },
    numbers: {
      sizeDeltaUsd: sizeDeltaUsd,
      initialCollateralDeltaAmount: collateralAmount,
      triggerPrice: triggerPrice, // Limit order trigger price
      acceptablePrice: acceptablePrice, // Max price after trigger
      executionFee: executionFee,
      callbackGasLimit: bigNumberify(0),
      minOutputAmount: bigNumberify(0),
      validFromTime: bigNumberify(0),
    },
    orderType: OrderType.LimitIncrease, // Limit order
    decreasePositionSwapType: 0,
    isLong: true, // LONG position
    shouldUnwrapNativeToken: false,
    autoCancel: false,
    referralCode: ethers.constants.HashZero,
    dataList: [], // Required by contract - empty array for no additional data
  };

  console.log("\nCreating limit long order...");

  // Use multicall to send order request
  const multicallArgs = [];

  if (isLongTokenWnt) {
    multicallArgs.push(
      exchangeRouter.interface.encodeFunctionData("sendWnt", [orderVault.address, collateralAmount.add(executionFee)])
    );
  } else {
    multicallArgs.push(
      exchangeRouter.interface.encodeFunctionData("sendTokens", [
        longTokenAddress,
        orderVault.address,
        collateralAmount,
      ])
    );
    multicallArgs.push(exchangeRouter.interface.encodeFunctionData("sendWnt", [orderVault.address, executionFee]));
  }

  multicallArgs.push(exchangeRouter.interface.encodeFunctionData("createOrder", [params]));

  const totalBnbValue = isLongTokenWnt ? collateralAmount.add(executionFee) : executionFee;

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

  // Query pending orders count
  const ORDER_LIST_KEY = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("ORDER_LIST"));
  const orderCount = await dataStore.getBytes32Count(ORDER_LIST_KEY);
  console.log("\nTotal pending orders:", orderCount.toString());

  console.log("\n=== Limit Long Order created successfully! ===");
  console.log("\nOrder will be executed when:");
  console.log("  Price drops to <= $" + triggerPriceUsd.toLocaleString());
  console.log("\nThe order is stored on-chain and in Keeper's Redis.");
  console.log("Use 'make user-cancel-order ORDER_KEY=0x...' to cancel.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
