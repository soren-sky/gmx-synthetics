import hre from "hardhat";
import { bigNumberify, expandDecimals } from "../utils/math";
import { MintableToken } from "../typechain-types";

const { ethers, deployments } = hre as any;

/**
 * User GLV Withdraw Script
 * Withdraw from GLV (GMX Liquidity Vault) by redeeming GLV tokens
 *
 * Environment Variables:
 *   GLV_ADDRESS: GLV address (optional, auto-detect first GLV if not provided)
 *   MARKET_ADDRESS: Market address to withdraw from (optional, auto-detect first market)
 *   WITHDRAW_AMOUNT: Amount of GLV tokens to withdraw (optional, default 50% of balance)
 *   WITHDRAW_PERCENT: Percentage of GLV tokens to withdraw (optional, default 50)
 *
 * Prerequisites: User must have GLV tokens (from a previous GLV deposit)
 */

interface GlvInfo {
  glvToken: string;
  longToken: string;
  shortToken: string;
  longDecimals: number;
  shortDecimals: number;
}

async function getTokenDecimals(tokenAddress: string): Promise<number> {
  try {
    const token = await ethers.getContractAt("IERC20Metadata", tokenAddress);
    return await token.decimals();
  } catch {
    return 18;
  }
}

async function getFirstGlv(): Promise<GlvInfo> {
  const glvReader = await ethers.getContract("GlvReader");
  const dataStore = await ethers.getContract("DataStore");

  const glvs = await glvReader.getGlvs(dataStore.address, 0, 10);

  if (glvs.length === 0) {
    throw new Error("No GLVs found! Please deploy GLV first with: make create-glv");
  }

  const glv = glvs[0];
  const longDecimals = await getTokenDecimals(glv.longToken);
  const shortDecimals = await getTokenDecimals(glv.shortToken);

  console.log("\nGLV Info:");
  console.log("  GLV Token:", glv.glvToken);
  console.log("  Long Token:", glv.longToken, `(${longDecimals} decimals)`);
  console.log("  Short Token:", glv.shortToken, `(${shortDecimals} decimals)`);

  return {
    glvToken: glv.glvToken,
    longToken: glv.longToken,
    shortToken: glv.shortToken,
    longDecimals,
    shortDecimals,
  };
}

async function getGlvMarkets(glvToken: string): Promise<string[]> {
  const glvReader = await ethers.getContract("GlvReader");
  const dataStore = await ethers.getContract("DataStore");

  const glvInfo = await glvReader.getGlvInfo(dataStore.address, glvToken);
  // GlvInfo struct: (glv, markets, glvTokenPriceMin, glvTokenPriceMax, ...)
  const markets = glvInfo.markets || glvInfo[1] || [];

  console.log("  Registered Markets:", markets.length);
  return markets;
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
  const glvRouter = await ethers.getContract("GlvRouter");
  const glvVault = await ethers.getContract("GlvVault");
  const router = await ethers.getContract("Router");
  const dataStore = await ethers.getContract("DataStore");

  console.log("\nContract addresses:");
  console.log("  GlvRouter:", glvRouter.address);
  console.log("  GlvVault:", glvVault.address);

  // Get GLV address
  let glvToken: string;
  let longTokenAddress: string;
  let shortTokenAddress: string;

  if (process.env.GLV_ADDRESS) {
    glvToken = process.env.GLV_ADDRESS;
    const glvReader = await ethers.getContract("GlvReader");
    const glvInfo = await glvReader.getGlvInfo(dataStore.address, glvToken);
    longTokenAddress = glvInfo.glv?.longToken || glvInfo[0]?.longToken;
    shortTokenAddress = glvInfo.glv?.shortToken || glvInfo[0]?.shortToken;
    const longDecimals = await getTokenDecimals(longTokenAddress);
    const shortDecimals = await getTokenDecimals(shortTokenAddress);
    console.log("\nUsing specified GLV:", glvToken);
    console.log("  Long Token:", longTokenAddress, `(${longDecimals} decimals)`);
    console.log("  Short Token:", shortTokenAddress, `(${shortDecimals} decimals)`);
  } else {
    const glvInfo = await getFirstGlv();
    glvToken = glvInfo.glvToken;
    longTokenAddress = glvInfo.longToken;
    shortTokenAddress = glvInfo.shortToken;
  }

  // Get markets registered in GLV
  const glvMarkets = await getGlvMarkets(glvToken);
  if (glvMarkets.length === 0) {
    console.error("\nError: No markets registered in GLV!");
    process.exit(1);
  }

  // Get market address for withdrawal
  const marketAddress = process.env.MARKET_ADDRESS || glvMarkets[0];
  console.log("  Withdrawal Market:", marketAddress);

  // Get WNT address (dynamic from DataStore)
  const wntAddress = await getWntAddress();
  const isLongTokenWnt = longTokenAddress.toLowerCase() === wntAddress.toLowerCase();
  console.log("  WNT:", wntAddress);
  console.log("  Long token is WNT:", isLongTokenWnt);

  // Get GLV token contract and check balance
  const glvTokenContract: MintableToken = await ethers.getContractAt("MintableToken", glvToken);
  const glvBalance = await glvTokenContract.balanceOf(wallet.address);
  console.log("\nUser GLV Token Balance:", ethers.utils.formatEther(glvBalance), "GLV");

  if (glvBalance.eq(0)) {
    console.error("\nError: No GLV tokens to withdraw!");
    console.log("Please deposit to GLV first using 'make user-glv-deposit'");
    process.exit(1);
  }

  // Calculate withdrawal amount
  let glvWithdrawAmount;
  if (process.env.WITHDRAW_AMOUNT) {
    glvWithdrawAmount = expandDecimals(parseInt(process.env.WITHDRAW_AMOUNT), 18);
  } else {
    const withdrawPercent = process.env.WITHDRAW_PERCENT ? parseInt(process.env.WITHDRAW_PERCENT) : 50;
    glvWithdrawAmount = glvBalance.mul(withdrawPercent).div(100);
    console.log("  Withdraw Percent:", withdrawPercent, "%");
  }

  // Ensure we don't try to withdraw more than we have
  if (glvWithdrawAmount.gt(glvBalance)) {
    console.log("  Adjusting withdrawal amount to max balance");
    glvWithdrawAmount = glvBalance;
  }

  // Execution fee: 0.03 BNB (needs to be higher for GLV withdrawal - similar to deposit)
  const executionFee = expandDecimals(3, 16);

  console.log("\nGLV Withdrawal Details:");
  console.log("  GLV Token:", glvToken);
  console.log("  Withdrawal Market:", marketAddress);
  console.log("  GLV Amount to Withdraw:", ethers.utils.formatEther(glvWithdrawAmount), "GLV");
  console.log("  Execution Fee:", ethers.utils.formatEther(executionFee), "BNB");
  console.log("  shouldUnwrapNativeToken:", isLongTokenWnt);

  // Approve Router to spend GLV tokens
  const glvAllowance = await glvTokenContract.allowance(wallet.address, router.address);
  if (glvAllowance.lt(glvWithdrawAmount)) {
    console.log("\nApproving GLV tokens...");
    const approveTx = await glvTokenContract.approve(router.address, ethers.constants.MaxUint256);
    await approveTx.wait();
  }

  // Build GLV Withdrawal params
  // IGlvWithdrawalUtils.CreateGlvWithdrawalParams
  const params = {
    addresses: {
      receiver: wallet.address,
      callbackContract: ethers.constants.AddressZero,
      uiFeeReceiver: ethers.constants.AddressZero,
      market: marketAddress,
      glv: glvToken,
      longTokenSwapPath: [],
      shortTokenSwapPath: [],
    },
    minLongTokenAmount: bigNumberify(0),
    minShortTokenAmount: bigNumberify(0),
    shouldUnwrapNativeToken: isLongTokenWnt, // Unwrap WNT to native token if applicable
    executionFee: executionFee,
    callbackGasLimit: bigNumberify(0),
    dataList: [],
  };

  console.log("\nCreating GLV withdrawal...");

  // Use multicall to send GLV withdrawal request
  const multicallArgs = [];

  // Send GLV tokens to GlvVault
  multicallArgs.push(
    glvRouter.interface.encodeFunctionData("sendTokens", [glvToken, glvVault.address, glvWithdrawAmount])
  );

  // Send execution fee (BNB)
  multicallArgs.push(glvRouter.interface.encodeFunctionData("sendWnt", [glvVault.address, executionFee]));

  // Create GLV withdrawal
  multicallArgs.push(glvRouter.interface.encodeFunctionData("createGlvWithdrawal", [params]));

  // Simulate transaction
  console.log("\nSimulating transaction...");
  try {
    await glvRouter.callStatic.multicall(multicallArgs, {
      value: executionFee,
      gasLimit: 8000000,
    });
    console.log("Simulation successful");
  } catch (e: any) {
    console.error("Simulation failed:", e.message);
    console.log("\nPossible reasons:");
    console.log("  - GLV token balance is 0");
    console.log("  - Market not registered in GLV");
    console.log("  - Insufficient liquidity in market");
    process.exit(1);
  }

  // Execute transaction
  console.log("\nSending transaction...");
  const tx = await glvRouter.multicall(multicallArgs, {
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

  // Query pending GLV withdrawals count
  const GLV_WITHDRAWAL_LIST_KEY = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("GLV_WITHDRAWAL_LIST"));
  const glvWithdrawalCount = await dataStore.getBytes32Count(GLV_WITHDRAWAL_LIST_KEY);
  console.log("\nTotal pending GLV withdrawals:", glvWithdrawalCount.toString());

  console.log("\n=== GLV Withdrawal request created successfully! ===");
  console.log("The withdrawal will be executed by a keeper.");
  console.log("\nAfter execution, you will receive:");
  console.log("  - Long Token (ETH/WBNB)");
  console.log("  - Short Token (USDC)");
  console.log("Proportional to your GLV token share and market composition.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
