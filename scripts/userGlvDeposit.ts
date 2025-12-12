import hre from "hardhat";
import { bigNumberify, expandDecimals } from "../utils/math";
import { MintableToken } from "../typechain-types";

const { ethers, deployments } = hre as any;

/**
 * User GLV Deposit Script
 * Deposit tokens to GLV (GMX Liquidity Vault) to receive GLV tokens
 *
 * This script will:
 * 1. Check if markets in GLV have liquidity
 * 2. If no liquidity, automatically do a market deposit first
 * 3. Wait for keeper to execute the market deposit
 * 4. Then proceed with GLV deposit
 *
 * Environment Variables:
 *   GLV_ADDRESS: GLV address (optional, auto-detect first GLV if not provided)
 *   MARKET_ADDRESS: Market address within GLV (optional, auto-detect first market)
 *   LONG_AMOUNT: Amount of long token in units (optional, default 0.1)
 *   SHORT_AMOUNT: Amount of short token in units (optional, default 500)
 *   SKIP_MARKET_DEPOSIT: Skip market deposit check (optional, default false)
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

// Check if market has liquidity by checking token balances held by market contract
async function checkMarketLiquidity(
  marketAddress: string
): Promise<{ hasLiquidity: boolean; longPool: any; shortPool: any }> {
  const reader = await ethers.getContract("Reader");
  const dataStore = await ethers.getContract("DataStore");

  const market = await reader.getMarket(dataStore.address, marketAddress);

  // Check actual token balances held by market contract
  const longToken = await ethers.getContractAt("IERC20", market.longToken);
  const shortToken = await ethers.getContractAt("IERC20", market.shortToken);

  const longPoolAmount = await longToken.balanceOf(marketAddress);
  const shortPoolAmount = await shortToken.balanceOf(marketAddress);

  const hasLiquidity = longPoolAmount.gt(0) || shortPoolAmount.gt(0);

  return { hasLiquidity, longPool: longPoolAmount, shortPool: shortPoolAmount };
}

// Execute market deposit to add initial liquidity
async function executeMarketDeposit(
  marketAddress: string,
  longTokenAddress: string,
  shortTokenAddress: string,
  longDecimals: number,
  shortDecimals: number,
  wntAddress: string
): Promise<void> {
  const [wallet] = await ethers.getSigners();
  const exchangeRouter = await ethers.getContract("ExchangeRouter");
  const router = await ethers.getContract("Router");
  const depositVault = await ethers.getContract("DepositVault");

  const isLongTokenWnt = longTokenAddress.toLowerCase() === wntAddress.toLowerCase();

  // Small amounts for initial liquidity: 0.05 BNB + 250 USDC
  const longAmount = ethers.utils.parseUnits("0.05", longDecimals);
  const shortAmount = ethers.utils.parseUnits("250", shortDecimals);
  const executionFee = expandDecimals(2, 16); // 0.02 BNB

  console.log("\n=== Adding initial liquidity to market ===");
  console.log("  Market:", marketAddress);
  console.log("  Long amount: 0.05 tokens");
  console.log("  Short amount: 250 tokens");

  // Get token contracts
  const longToken: MintableToken = await ethers.getContractAt("MintableToken", longTokenAddress);
  const shortToken: MintableToken = await ethers.getContractAt("MintableToken", shortTokenAddress);

  // Mint short token if needed
  const shortBalance = await shortToken.balanceOf(wallet.address);
  if (shortBalance.lt(shortAmount)) {
    console.log("  Minting short token...");
    try {
      const mintTx = await shortToken.mint(wallet.address, shortAmount);
      await mintTx.wait();
    } catch (e) {
      console.log("  Note: Could not mint short token");
    }
  }

  // Approve router
  const shortAllowance = await shortToken.allowance(wallet.address, router.address);
  if (shortAllowance.lt(shortAmount)) {
    console.log("  Approving short token...");
    const approveTx = await shortToken.approve(router.address, ethers.constants.MaxUint256);
    await approveTx.wait();
  }

  if (!isLongTokenWnt) {
    const longAllowance = await longToken.allowance(wallet.address, router.address);
    if (longAllowance.lt(longAmount)) {
      console.log("  Approving long token...");
      const approveTx = await longToken.approve(router.address, ethers.constants.MaxUint256);
      await approveTx.wait();
    }
  }

  // Build deposit params - must match CreateDepositParams struct
  const params = {
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
    minMarketTokens: bigNumberify(0),
    shouldUnwrapNativeToken: false,
    executionFee: executionFee,
    callbackGasLimit: bigNumberify(0),
    dataList: [],
  };

  // Build multicall
  const multicallArgs = [];

  if (isLongTokenWnt) {
    multicallArgs.push(
      exchangeRouter.interface.encodeFunctionData("sendWnt", [depositVault.address, longAmount.add(executionFee)])
    );
  } else {
    multicallArgs.push(
      exchangeRouter.interface.encodeFunctionData("sendTokens", [longTokenAddress, depositVault.address, longAmount])
    );
    multicallArgs.push(exchangeRouter.interface.encodeFunctionData("sendWnt", [depositVault.address, executionFee]));
  }

  multicallArgs.push(
    exchangeRouter.interface.encodeFunctionData("sendTokens", [shortTokenAddress, depositVault.address, shortAmount])
  );

  multicallArgs.push(exchangeRouter.interface.encodeFunctionData("createDeposit", [params]));

  const totalValue = isLongTokenWnt ? longAmount.add(executionFee) : executionFee;

  console.log("  Sending market deposit transaction...");
  const tx = await exchangeRouter.multicall(multicallArgs, {
    value: totalValue,
    gasLimit: 8000000,
  });

  console.log("  TX:", tx.hash);
  await tx.wait();
  console.log("  Market deposit request created!");
  console.log("\n  ⏳ Waiting for keeper to execute deposit (30 seconds)...");

  // Wait for keeper to execute
  await new Promise((resolve) => setTimeout(resolve, 30000));

  // Check if liquidity was added
  const { hasLiquidity } = await checkMarketLiquidity(marketAddress);
  if (hasLiquidity) {
    console.log("  ✅ Market now has liquidity!");
  } else {
    console.log("  ⚠️  Liquidity not yet added. Keeper may still be processing.");
    console.log("     You can wait longer or run this script again.");
  }
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
  let longDecimals: number;
  let shortDecimals: number;

  if (process.env.GLV_ADDRESS) {
    glvToken = process.env.GLV_ADDRESS;
    const glvReader = await ethers.getContract("GlvReader");
    const glvInfo = await glvReader.getGlvInfo(dataStore.address, glvToken);
    longTokenAddress = glvInfo.glv?.longToken || glvInfo[0]?.longToken;
    shortTokenAddress = glvInfo.glv?.shortToken || glvInfo[0]?.shortToken;
    longDecimals = await getTokenDecimals(longTokenAddress);
    shortDecimals = await getTokenDecimals(shortTokenAddress);
    console.log("\nUsing specified GLV:", glvToken);
    console.log("  Long Token:", longTokenAddress, `(${longDecimals} decimals)`);
    console.log("  Short Token:", shortTokenAddress, `(${shortDecimals} decimals)`);
  } else {
    const glvInfo = await getFirstGlv();
    glvToken = glvInfo.glvToken;
    longTokenAddress = glvInfo.longToken;
    shortTokenAddress = glvInfo.shortToken;
    longDecimals = glvInfo.longDecimals;
    shortDecimals = glvInfo.shortDecimals;
  }

  // Get markets registered in GLV
  const glvMarkets = await getGlvMarkets(glvToken);
  if (glvMarkets.length === 0) {
    console.error("\nError: No markets registered in GLV!");
    process.exit(1);
  }

  // Get market address
  const marketAddress = process.env.MARKET_ADDRESS || glvMarkets[0];
  console.log("  Using Market:", marketAddress);

  // Get WNT address
  const wntAddress = await getWntAddress();
  const isLongTokenWnt = longTokenAddress.toLowerCase() === wntAddress.toLowerCase();
  console.log("  WNT:", wntAddress);
  console.log("  Long token is WNT:", isLongTokenWnt);

  // Check market liquidity (unless skipped)
  if (process.env.SKIP_MARKET_DEPOSIT !== "true") {
    console.log("\n=== Checking market liquidity ===");
    const { hasLiquidity, longPool, shortPool } = await checkMarketLiquidity(marketAddress);
    console.log("  Long pool:", ethers.utils.formatUnits(longPool, longDecimals));
    console.log("  Short pool:", ethers.utils.formatUnits(shortPool, shortDecimals));

    if (!hasLiquidity) {
      console.log("\n⚠️  Market has no liquidity! GLV deposit requires market liquidity.");
      console.log("   Automatically adding initial liquidity to market...");

      await executeMarketDeposit(
        marketAddress,
        longTokenAddress,
        shortTokenAddress,
        longDecimals,
        shortDecimals,
        wntAddress
      );

      // Re-check liquidity
      const recheck = await checkMarketLiquidity(marketAddress);
      if (!recheck.hasLiquidity) {
        console.log("\n❌ Market still has no liquidity. Please wait for keeper and try again.");
        console.log("   Or run: SKIP_MARKET_DEPOSIT=true make user-glv-deposit");
        process.exit(1);
      }
    } else {
      console.log("  ✅ Market has liquidity, proceeding with GLV deposit");
    }
  }

  // Parse amounts - reduced defaults for testnet
  // LONG_AMOUNT: Amount of long token (default 0.1 for testnet)
  const longAmountUnits = process.env.LONG_AMOUNT ? parseFloat(process.env.LONG_AMOUNT) : 0.1;
  const longTokenAmount = ethers.utils.parseUnits(longAmountUnits.toString(), longDecimals);

  // SHORT_AMOUNT: Amount of short token (default 500 for testnet)
  const shortAmountUnits = process.env.SHORT_AMOUNT ? parseFloat(process.env.SHORT_AMOUNT) : 500;
  const shortTokenAmount = ethers.utils.parseUnits(shortAmountUnits.toString(), shortDecimals);

  // Execution fee: 0.03 BNB (needs to be higher for GLV deposit - actual cost ~0.0227 BNB)
  const executionFee = expandDecimals(3, 16);

  console.log("\nGLV Deposit Details:");
  console.log("  GLV Token:", glvToken);
  console.log("  Market:", marketAddress);
  console.log("  Long Token Amount:", longAmountUnits, `tokens (${longDecimals} decimals)`);
  console.log("  Short Token Amount:", shortAmountUnits.toLocaleString(), `tokens (${shortDecimals} decimals)`);
  console.log("  Execution Fee:", ethers.utils.formatEther(executionFee), "BNB");
  console.log("  isMarketTokenDeposit:", false, "(using raw tokens)");

  // Get token contracts
  const longToken: MintableToken = await ethers.getContractAt("MintableToken", longTokenAddress);
  const shortToken: MintableToken = await ethers.getContractAt("MintableToken", shortTokenAddress);

  // Check and prepare long token
  // NOTE: If long token is WNT, we DON'T pre-wrap BNB.
  // sendWnt in multicall handles BNB->WBNB conversion automatically.
  // We just need to send enough BNB as msg.value.
  if (!isLongTokenWnt) {
    const longTokenBalance = await longToken.balanceOf(wallet.address);
    console.log("\nCurrent long token balance:", ethers.utils.formatUnits(longTokenBalance, longDecimals));

    if (longTokenBalance.lt(longTokenAmount)) {
      console.log("Minting long token for testing...");
      try {
        const mintTx = await longToken.mint(wallet.address, longTokenAmount);
        await mintTx.wait();
        console.log("Long token minted");
      } catch (e) {
        console.log("Note: Could not mint long token (may not be a MintableToken)");
      }
    }
  } else {
    console.log("\nLong token is WNT - will send BNB directly via sendWnt");
  }

  // Check and prepare short token
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

  // Approve Router for tokens
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

  // Build GLV Deposit params
  const params = {
    addresses: {
      glv: glvToken,
      market: marketAddress,
      receiver: wallet.address,
      callbackContract: ethers.constants.AddressZero,
      uiFeeReceiver: ethers.constants.AddressZero,
      initialLongToken: longTokenAddress,
      initialShortToken: shortTokenAddress,
      longTokenSwapPath: [],
      shortTokenSwapPath: [],
    },
    minGlvTokens: bigNumberify(0),
    executionFee: executionFee,
    callbackGasLimit: bigNumberify(0),
    shouldUnwrapNativeToken: false,
    isMarketTokenDeposit: false,
    dataList: [],
  };

  console.log("\nCreating GLV deposit...");

  // Use multicall to send GLV deposit request
  const multicallArgs = [];

  if (isLongTokenWnt) {
    multicallArgs.push(
      glvRouter.interface.encodeFunctionData("sendWnt", [glvVault.address, longTokenAmount.add(executionFee)])
    );
  } else {
    multicallArgs.push(
      glvRouter.interface.encodeFunctionData("sendTokens", [longTokenAddress, glvVault.address, longTokenAmount])
    );
    multicallArgs.push(glvRouter.interface.encodeFunctionData("sendWnt", [glvVault.address, executionFee]));
  }

  multicallArgs.push(
    glvRouter.interface.encodeFunctionData("sendTokens", [shortTokenAddress, glvVault.address, shortTokenAmount])
  );

  multicallArgs.push(glvRouter.interface.encodeFunctionData("createGlvDeposit", [params]));

  const totalBnbValue = isLongTokenWnt ? longTokenAmount.add(executionFee) : executionFee;

  // Simulate transaction
  console.log("\nSimulating transaction...");
  try {
    await glvRouter.callStatic.multicall(multicallArgs, {
      value: totalBnbValue,
      gasLimit: 8000000,
    });
    console.log("Simulation successful");
  } catch (e: any) {
    console.error("Simulation failed:", e.message);
    console.log("\nPossible reasons:");
    console.log("  - GLV not configured properly");
    console.log("  - Market not registered in GLV");
    console.log("  - Markets in GLV have no liquidity");
    process.exit(1);
  }

  // Execute transaction
  console.log("\nSending transaction...");
  const tx = await glvRouter.multicall(multicallArgs, {
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

  // Query pending GLV deposits count
  const GLV_DEPOSIT_LIST_KEY = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("GLV_DEPOSIT_LIST"));
  const glvDepositCount = await dataStore.getBytes32Count(GLV_DEPOSIT_LIST_KEY);
  console.log("\nTotal pending GLV deposits:", glvDepositCount.toString());

  console.log("\n=== GLV Deposit request created successfully! ===");
  console.log("The deposit will be executed by a keeper.");
  console.log("\nAfter execution, you will receive GLV tokens representing your share.");
  console.log("GLV provides diversified exposure to multiple markets.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
