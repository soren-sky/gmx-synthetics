import hre from "hardhat";
import { expandDecimals } from "../utils/math";
import { ExchangeRouter, MintableToken } from "../typechain-types";
import { WithdrawalUtils } from "../typechain-types/contracts/exchange/WithdrawalHandler";

const { ethers, deployments } = hre as any;

/**
 * User Withdraw Script
 * Execute a user withdrawal to redeem GM tokens for underlying assets
 *
 * Environment Variables:
 *   MARKET_ADDRESS: Market address (required)
 *   WITHDRAW_PERCENT: Percentage of GM tokens to withdraw (optional, default 50)
 *
 * The script will automatically get the user's GM balance and withdraw the specified percentage
 */

async function getTokenDecimals(tokenAddress: string): Promise<number> {
  try {
    const token = await ethers.getContractAt("IERC20Metadata", tokenAddress);
    return await token.decimals();
  } catch (_e) {
    return 18;
  }
}

async function getMarketTokens(marketAddress: string): Promise<{
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

  console.log("\nMarket info from chain:");
  console.log("  Market Token:", marketInfo.marketToken);
  console.log("  Index Token:", marketInfo.indexToken);
  console.log("  Long Token:", marketInfo.longToken, `(${longDecimals} decimals)`);
  console.log("  Short Token:", marketInfo.shortToken, `(${shortDecimals} decimals)`);

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
  const withdrawalVault = await ethers.getContract("WithdrawalVault");
  const dataStore = await ethers.getContract("DataStore");

  console.log("\nContract addresses:");
  console.log("  ExchangeRouter:", exchangeRouter.address);
  console.log("  Router:", router.address);
  console.log("  WithdrawalVault:", withdrawalVault.address);

  // Get Market address
  const marketAddress = process.env.MARKET_ADDRESS;
  if (!marketAddress) {
    console.error("\nError: MARKET_ADDRESS environment variable is required");
    console.log("\nUsage: MARKET_ADDRESS=0x... make user-withdraw");
    console.log("\nAvailable markets can be found using: make list-markets");
    process.exit(1);
  }
  console.log("  Market:", marketAddress);

  // Get market tokens with decimals (dynamic)
  const marketTokens = await getMarketTokens(marketAddress);

  // Get WNT address (dynamic from DataStore)
  const wntAddress = await getWntAddress();
  console.log("  WNT:", wntAddress);

  // Check if long token is WNT
  const isLongTokenWnt = marketTokens.longToken.toLowerCase() === wntAddress.toLowerCase();

  // Get GM token contract
  const marketToken: MintableToken = await ethers.getContractAt("MintableToken", marketAddress);

  // Get user's GM balance
  const gmBalance = await marketToken.balanceOf(wallet.address);
  console.log("\nUser GM balance:", ethers.utils.formatEther(gmBalance), "GM");

  if (gmBalance.eq(0)) {
    console.error("\nError: No GM tokens to withdraw!");
    console.log("Please run 'make user-deposit' first to get GM tokens");
    process.exit(1);
  }

  // Calculate withdrawal amount
  const withdrawPercent = process.env.WITHDRAW_PERCENT ? parseInt(process.env.WITHDRAW_PERCENT) : 50;
  const withdrawAmount = gmBalance.mul(withdrawPercent).div(100);

  console.log("\nWithdraw details:");
  console.log("  Withdraw percent:", withdrawPercent, "%");
  console.log("  Withdraw amount:", ethers.utils.formatEther(withdrawAmount), "GM");

  // Execution fee: 0.02 BNB
  const executionFee = expandDecimals(2, 16);
  console.log("  Execution fee:", ethers.utils.formatEther(executionFee), "BNB");

  // Approve Router to spend GM tokens
  const gmAllowance = await marketToken.allowance(wallet.address, router.address);
  if (gmAllowance.lt(withdrawAmount)) {
    console.log("\nApproving GM tokens...");
    const approveTx = await marketToken.approve(router.address, ethers.constants.MaxUint256);
    await approveTx.wait();
  }

  // Build Withdrawal params
  // Order must match IWithdrawalUtils.CreateWithdrawalParamsAddresses:
  // receiver, callbackContract, uiFeeReceiver, market, longTokenSwapPath, shortTokenSwapPath
  const params: WithdrawalUtils.CreateWithdrawalParamsStruct = {
    addresses: {
      receiver: wallet.address,
      callbackContract: ethers.constants.AddressZero,
      uiFeeReceiver: ethers.constants.AddressZero,
      market: marketAddress,
      longTokenSwapPath: [],
      shortTokenSwapPath: [],
    },
    minLongTokenAmount: 0,
    minShortTokenAmount: 0,
    shouldUnwrapNativeToken: isLongTokenWnt, // Unwrap WNT to native token if applicable
    executionFee: executionFee,
    callbackGasLimit: 0,
    dataList: [],
  };

  console.log("\nCreating withdrawal...");
  console.log("Params:", JSON.stringify(params, null, 2));

  // Use multicall to send withdrawal request
  const multicallArgs = [];

  // Send GM tokens to WithdrawalVault
  multicallArgs.push(
    exchangeRouter.interface.encodeFunctionData("sendTokens", [marketAddress, withdrawalVault.address, withdrawAmount])
  );

  // Send execution fee (BNB)
  multicallArgs.push(exchangeRouter.interface.encodeFunctionData("sendWnt", [withdrawalVault.address, executionFee]));

  // Create withdrawal
  multicallArgs.push(exchangeRouter.interface.encodeFunctionData("createWithdrawal", [params]));

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

  // Query pending withdrawals count
  const WITHDRAWAL_LIST_KEY = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("WITHDRAWAL_LIST"));
  const withdrawalCount = await dataStore.getBytes32Count(WITHDRAWAL_LIST_KEY);
  console.log("\nTotal pending withdrawals:", withdrawalCount.toString());

  console.log("\n=== Withdrawal request created successfully! ===");
  console.log("The withdrawal will be executed by a keeper.");
  console.log("You will receive:", isLongTokenWnt ? "Native Token" : "Long Token", "+", "Short Token");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
