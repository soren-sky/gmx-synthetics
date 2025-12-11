import hre from "hardhat";
import { bigNumberify, expandDecimals } from "../utils/math";
import { ExchangeRouter, MintableToken } from "../typechain-types";
import { DepositUtils } from "../typechain-types/contracts/exchange/DepositHandler";

const { ethers, deployments } = hre as any;

/**
 * Add Liquidity Script
 * Add large amounts of liquidity to a market for testing
 *
 * Environment Variables:
 *   MARKET_ADDRESS: Market address (required)
 *   LONG_AMOUNT: Amount of long token (ETH) in units (optional, default 1000)
 *   SHORT_AMOUNT: Amount of short token (USDC) in units (optional, default 5000000)
 *
 * This is used to prepare a market for trading tests.
 * It mints test tokens and deposits them to provide liquidity.
 */

async function getTokenDecimals(tokenAddress: string): Promise<number> {
  try {
    const token = await ethers.getContractAt("IERC20Metadata", tokenAddress);
    return await token.decimals();
  } catch {
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
  const depositVault = await ethers.getContract("DepositVault");
  const dataStore = await ethers.getContract("DataStore");

  console.log("\nContract addresses:");
  console.log("  ExchangeRouter:", exchangeRouter.address);
  console.log("  Router:", router.address);
  console.log("  DepositVault:", depositVault.address);

  // Get Market address
  const marketAddress = process.env.MARKET_ADDRESS;
  if (!marketAddress) {
    console.error("\nError: MARKET_ADDRESS environment variable is required");
    console.log("\nUsage: MARKET_ADDRESS=0x... make user-add-liquidity");
    console.log("\nAvailable markets can be found using: make list-markets");
    process.exit(1);
  }
  console.log("  Market:", marketAddress);

  // Get market tokens with decimals (dynamic)
  const marketTokens = await getMarketTokens(marketAddress);
  const longTokenAddress = marketTokens.longToken;
  const shortTokenAddress = marketTokens.shortToken;
  const longDecimals = marketTokens.longDecimals;
  const shortDecimals = marketTokens.shortDecimals;

  // Get WNT address (dynamic from DataStore)
  const wntAddress = await getWntAddress();
  const isLongTokenWnt = longTokenAddress.toLowerCase() === wntAddress.toLowerCase();
  console.log("  WNT:", wntAddress);
  console.log("  Long token is WNT:", isLongTokenWnt);

  // Parse amounts
  // LONG_AMOUNT: Amount of long token (default 1000)
  const longAmountUnits = process.env.LONG_AMOUNT ? parseInt(process.env.LONG_AMOUNT) : 1000;
  const longTokenAmount = expandDecimals(longAmountUnits, longDecimals);

  // SHORT_AMOUNT: Amount of short token (default 5M)
  // Decimals obtained dynamically from token contract
  const shortAmountUnits = process.env.SHORT_AMOUNT ? parseInt(process.env.SHORT_AMOUNT) : 5000000;
  const shortTokenAmount = expandDecimals(shortAmountUnits, shortDecimals);

  // Execution fee: 0.02 BNB
  const executionFee = expandDecimals(2, 16);

  console.log("\nLiquidity Details:");
  console.log("  Long Token Amount:", longAmountUnits.toLocaleString(), `tokens (${longDecimals} decimals)`);
  console.log("  Short Token Amount:", shortAmountUnits.toLocaleString(), `tokens (${shortDecimals} decimals)`);
  console.log("  Execution Fee:", ethers.utils.formatEther(executionFee), "BNB");

  // Get token contracts
  const longToken: MintableToken = await ethers.getContractAt("MintableToken", longTokenAddress);
  const shortToken: MintableToken = await ethers.getContractAt("MintableToken", shortTokenAddress);

  // Check and mint long token
  const longTokenBalance = await longToken.balanceOf(wallet.address);
  console.log("\nCurrent long token balance:", ethers.utils.formatUnits(longTokenBalance, longDecimals));

  if (isLongTokenWnt && longTokenBalance.lt(longTokenAmount)) {
    console.log("Wrapping native token to WNT...");
    const wntAbi = [
      "function deposit() external payable",
      "function balanceOf(address account) external view returns (uint256)",
    ];
    const wntContract = new ethers.Contract(wntAddress, wntAbi, wallet);
    const totalNeeded = longTokenAmount.add(executionFee);
    const depositTx = await wntContract.deposit({ value: totalNeeded });
    await depositTx.wait();
    console.log("WNT deposit complete");
  } else if (!isLongTokenWnt && longTokenBalance.lt(longTokenAmount)) {
    console.log("Minting long token for testing...");
    try {
      const mintTx = await longToken.mint(wallet.address, longTokenAmount);
      await mintTx.wait();
      console.log("Long token minted");
    } catch (e) {
      console.log("Note: Could not mint long token (may not be a MintableToken)");
    }
  }

  // Check and mint short token
  const shortTokenBalance = await shortToken.balanceOf(wallet.address);
  console.log("Current short token balance:", ethers.utils.formatUnits(shortTokenBalance, shortDecimals));

  if (shortTokenBalance.lt(shortTokenAmount)) {
    console.log("Minting short token for testing...");
    try {
      const mintTx = await shortToken.mint(wallet.address, shortTokenAmount);
      await mintTx.wait();
      console.log("Short token minted");
    } catch (e) {
      console.log("Note: Could not mint short token (may not be a MintableToken)");
    }
  }

  // Approve Router
  const longTokenAllowance = await longToken.allowance(wallet.address, router.address);
  if (longTokenAllowance.lt(longTokenAmount)) {
    console.log("\nApproving long token...");
    const approveTx = await longToken.approve(router.address, ethers.constants.MaxUint256);
    await approveTx.wait();
  }

  const shortTokenAllowance = await shortToken.allowance(wallet.address, router.address);
  if (shortTokenAllowance.lt(shortTokenAmount)) {
    console.log("Approving short token...");
    const approveTx = await shortToken.approve(router.address, ethers.constants.MaxUint256);
    await approveTx.wait();
  }

  // Build Deposit params
  const params: DepositUtils.CreateDepositParamsStruct = {
    // Order must match IDepositUtils.CreateDepositParamsAddresses:
    // receiver, callbackContract, uiFeeReceiver, market, initialLongToken, initialShortToken, longTokenSwapPath, shortTokenSwapPath
    addresses: {
      receiver: wallet.address,
      callbackContract: ethers.constants.AddressZero,
      uiFeeReceiver: ethers.constants.AddressZero,
      market: marketAddress,
      initialLongToken: longTokenAddress,
      initialShortToken: shortTokenAddress,
      longTokenSwapPath: [],
      shortTokenSwapPath: [],
    },
    minMarketTokens: 0,
    shouldUnwrapNativeToken: false,
    executionFee: executionFee,
    callbackGasLimit: 0,
    dataList: [],
  };

  console.log("\nAdding liquidity...");

  // Use multicall to send deposit request
  const multicallArgs = [];

  if (isLongTokenWnt) {
    multicallArgs.push(
      exchangeRouter.interface.encodeFunctionData("sendWnt", [depositVault.address, longTokenAmount.add(executionFee)])
    );
  } else {
    multicallArgs.push(
      exchangeRouter.interface.encodeFunctionData("sendTokens", [
        longTokenAddress,
        depositVault.address,
        longTokenAmount,
      ])
    );
    multicallArgs.push(exchangeRouter.interface.encodeFunctionData("sendWnt", [depositVault.address, executionFee]));
  }

  multicallArgs.push(
    exchangeRouter.interface.encodeFunctionData("sendTokens", [
      shortTokenAddress,
      depositVault.address,
      shortTokenAmount,
    ])
  );

  multicallArgs.push(exchangeRouter.interface.encodeFunctionData("createDeposit", [params]));

  const totalBnbValue = isLongTokenWnt ? longTokenAmount.add(executionFee) : executionFee;

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

  // Query pending deposits count
  const DEPOSIT_LIST_KEY = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("DEPOSIT_LIST"));
  const depositCount = await dataStore.getBytes32Count(DEPOSIT_LIST_KEY);
  console.log("\nTotal pending deposits:", depositCount.toString());

  console.log("\n=== Liquidity deposit request created successfully! ===");
  console.log("The deposit will be executed by a keeper.");
  console.log("\nAfter execution, the market will have:");
  console.log("  Long Token Pool:", longAmountUnits.toLocaleString(), "tokens");
  console.log("  Short Token Pool:", shortAmountUnits.toLocaleString(), "tokens");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
