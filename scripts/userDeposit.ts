import hre from "hardhat";
import { bigNumberify, expandDecimals } from "../utils/math";
import { ExchangeRouter, MintableToken } from "../typechain-types";
import { DepositUtils } from "../typechain-types/contracts/exchange/DepositHandler";

const { ethers, deployments } = hre as any;

/**
 * 用户 Deposit 脚本
 * 执行一笔用户的 deposit 操作，向指定 market 存入资金
 *
 * 环境变量:
 *   MARKET_ADDRESS: Market 地址（必填）
 *   LONG_TOKEN_AMOUNT: Long token 数量（可选，默认 0.001）
 *   SHORT_TOKEN_AMOUNT: Short token 数量（可选，默认 10 USDC）
 *
 * 脚本会自动从 Market 获取正确的 long/short token 地址
 */

async function getTokenDecimals(tokenAddress: string): Promise<number> {
  try {
    const token = await ethers.getContractAt("IERC20Metadata", tokenAddress);
    return await token.decimals();
  } catch {
    return 18;
  }
}

async function getMarketTokens(
  marketAddress: string
): Promise<{ longToken: string; shortToken: string; indexToken: string; longDecimals: number; shortDecimals: number }> {
  const reader = await ethers.getContract("Reader");
  const dataStore = await ethers.getContract("DataStore");

  // Call Reader.getMarket to get market info
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
  } catch {
    // WNT not found in DataStore
  }
  try {
    const wbnb = await deployments.get("WBNB");
    return wbnb.address;
  } catch {
    // WBNB deployment not found
  }
  return "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
}

async function main() {
  const [wallet] = await ethers.getSigners();
  console.log("Wallet address:", wallet.address);
  console.log("Wallet balance:", ethers.utils.formatEther(await wallet.getBalance()), "BNB");

  // 获取合约实例
  const exchangeRouter: ExchangeRouter = await ethers.getContract("ExchangeRouter");
  const router = await ethers.getContract("Router");
  const depositVault = await ethers.getContract("DepositVault");
  const dataStore = await ethers.getContract("DataStore");

  console.log("\nContract addresses:");
  console.log("  ExchangeRouter:", exchangeRouter.address);
  console.log("  Router:", router.address);
  console.log("  DepositVault:", depositVault.address);

  // 获取 Market 地址
  const marketAddress = process.env.MARKET_ADDRESS;
  if (!marketAddress) {
    console.error("\nError: MARKET_ADDRESS environment variable is required");
    console.log("\nUsage: MARKET_ADDRESS=0x... make user-deposit");
    console.log("\nAvailable markets can be found using: make list-markets");
    process.exit(1);
  }
  console.log("  Market:", marketAddress);

  // 从 Market 获取正确的 long/short token 地址
  const marketTokens = await getMarketTokens(marketAddress);
  const longTokenAddress = marketTokens.longToken;
  const shortTokenAddress = marketTokens.shortToken;
  const longDecimals = marketTokens.longDecimals;
  const shortDecimals = marketTokens.shortDecimals;

  console.log("\nUsing tokens from market:");
  console.log("  Long Token:", longTokenAddress);
  console.log("  Short Token:", shortTokenAddress);

  // 获取 WNT 地址用于 native token 操作
  const wntAddress = await getWntAddress();
  console.log("  WNT:", wntAddress);

  // 检查 long token 是否是 WNT (用于判断是否需要 wrap BNB)
  const isLongTokenWnt = longTokenAddress.toLowerCase() === wntAddress.toLowerCase();
  console.log("  Long token is WNT:", isLongTokenWnt);

  // 获取 token 合约实例
  const longToken = await ethers.getContractAt("MintableToken", longTokenAddress);
  const shortToken: MintableToken = await ethers.getContractAt("MintableToken", shortTokenAddress);

  // 设置金额
  // Long token: 默认 0.001 (dynamic decimals)
  const longTokenAmount = process.env.LONG_TOKEN_AMOUNT
    ? bigNumberify(process.env.LONG_TOKEN_AMOUNT)
    : expandDecimals(1, longDecimals - 3);

  // Short token: 默认 10 USDC (dynamic decimals)
  const shortTokenAmount = process.env.SHORT_TOKEN_AMOUNT
    ? bigNumberify(process.env.SHORT_TOKEN_AMOUNT)
    : expandDecimals(10, shortDecimals);

  // Execution fee: 0.02 BNB (must be >= estimated gas fee from DataStore)
  // GMX calculates: estimatedGasFeeBaseAmount + estimatedGasPerOraclePrice * numPrices
  // On BSC testnet: ~600000 + 250000 * numPrices, with multiplier
  const executionFee = expandDecimals(2, 16); // 0.02 BNB

  console.log("\nDeposit amounts:");
  console.log("  Long token amount:", longTokenAmount.toString());
  console.log("  Short token amount:", shortTokenAmount.toString());
  console.log("  Execution fee:", executionFee.toString());

  // 检查和获取 long token (如果是 WNT，需要 wrap BNB)
  const longTokenBalance = await longToken.balanceOf(wallet.address);
  console.log("\nCurrent long token balance:", ethers.utils.formatUnits(longTokenBalance, longDecimals));

  if (isLongTokenWnt && longTokenBalance.lt(longTokenAmount)) {
    console.log("Wrapping BNB to WNT...");
    // Use minimal WNT ABI for deposit function
    const wntAbi = [
      "function deposit() external payable",
      "function withdraw(uint256 amount) external",
      "function balanceOf(address account) external view returns (uint256)",
    ];
    const wntContract = new ethers.Contract(wntAddress, wntAbi, wallet);
    const depositTx = await wntContract.deposit({ value: longTokenAmount.add(executionFee) });
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

  // 检查和 mint short token (用于测试网)
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

  // 授权 Router
  const longTokenAllowance = await longToken.allowance(wallet.address, router.address);
  if (longTokenAllowance.lt(longTokenAmount.add(isLongTokenWnt ? executionFee : bigNumberify(0)))) {
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

  // 构建 Deposit 参数
  // IMPORTANT: initialLongToken/initialShortToken 必须与 market 的 longToken/shortToken 匹配
  // 否则会出现 InvalidSwapOutputToken 错误
  // Order must match IDepositUtils.CreateDepositParamsAddresses:
  // receiver, callbackContract, uiFeeReceiver, market, initialLongToken, initialShortToken, longTokenSwapPath, shortTokenSwapPath
  const params: DepositUtils.CreateDepositParamsStruct = {
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

  console.log("\nCreating deposit...");
  console.log("Params:", JSON.stringify(params, null, 2));

  // 使用 multicall 发送 deposit 请求
  // 对于 WNT market，需要使用 sendWnt 发送原生 BNB
  const multicallArgs = [];

  if (isLongTokenWnt) {
    // Long token 是 WNT，使用 sendWnt 发送 BNB (会自动 wrap)
    multicallArgs.push(
      exchangeRouter.interface.encodeFunctionData("sendWnt", [depositVault.address, longTokenAmount.add(executionFee)])
    );
  } else {
    // Long token 不是 WNT，使用 sendTokens
    multicallArgs.push(
      exchangeRouter.interface.encodeFunctionData("sendTokens", [
        longTokenAddress,
        depositVault.address,
        longTokenAmount,
      ])
    );
    // 单独发送 execution fee (BNB)
    multicallArgs.push(exchangeRouter.interface.encodeFunctionData("sendWnt", [depositVault.address, executionFee]));
  }

  // 发送 short token
  multicallArgs.push(
    exchangeRouter.interface.encodeFunctionData("sendTokens", [
      shortTokenAddress,
      depositVault.address,
      shortTokenAmount,
    ])
  );

  // 创建 deposit
  multicallArgs.push(exchangeRouter.interface.encodeFunctionData("createDeposit", [params]));

  // 计算需要发送的 BNB 总量
  const totalBnbValue = isLongTokenWnt ? longTokenAmount.add(executionFee) : executionFee;

  // 先执行 callStatic 检查
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

  // 执行实际交易
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

  // 查询创建的 deposit 数量
  const DEPOSIT_LIST_KEY = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("DEPOSIT_LIST"));
  const depositCount = await dataStore.getBytes32Count(DEPOSIT_LIST_KEY);
  console.log("\nTotal pending deposits:", depositCount.toString());

  console.log("\n=== Deposit request created successfully! ===");
  console.log("The deposit will be executed by a keeper.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
