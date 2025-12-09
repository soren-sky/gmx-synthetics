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
 *   LONG_TOKEN_AMOUNT: Long token 数量（可选，默认 0.001 ETH）
 *   SHORT_TOKEN_AMOUNT: Short token 数量（可选，默认 10 USDC）
 */

async function getWntAddress(): Promise<string> {
  // 尝试从环境变量或部署获取 WNT 地址
  if (process.env.WNT_ADDRESS) {
    return process.env.WNT_ADDRESS;
  }

  // 尝试获取已部署的 WETH/WNT
  try {
    const weth = await deployments.get("WETH");
    return weth.address;
  } catch {
    try {
      const eth = await deployments.get("ETH");
      return eth.address;
    } catch {
      throw new Error("WNT/WETH not found in deployments. Set WNT_ADDRESS env var.");
    }
  }
}

async function getUsdcAddress(): Promise<string> {
  if (process.env.USDC_ADDRESS) {
    return process.env.USDC_ADDRESS;
  }

  try {
    const usdc = await deployments.get("USDC");
    return usdc.address;
  } catch {
    throw new Error("USDC not found in deployments. Set USDC_ADDRESS env var.");
  }
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

  // 获取 token 地址
  const wntAddress = await getWntAddress();
  const usdcAddress = await getUsdcAddress();

  console.log("\nContract addresses:");
  console.log("  ExchangeRouter:", exchangeRouter.address);
  console.log("  Router:", router.address);
  console.log("  DepositVault:", depositVault.address);
  console.log("  WNT:", wntAddress);
  console.log("  USDC:", usdcAddress);

  // 获取 Market 地址
  const marketAddress = process.env.MARKET_ADDRESS;
  if (!marketAddress) {
    console.error("\nError: MARKET_ADDRESS environment variable is required");
    console.log("\nUsage: MARKET_ADDRESS=0x... make user-deposit");
    console.log("\nAvailable markets can be found using: make list-markets");
    process.exit(1);
  }
  console.log("  Market:", marketAddress);

  // 获取 token 合约实例
  const wnt = await ethers.getContractAt("MintableToken", wntAddress);
  const usdc: MintableToken = await ethers.getContractAt("MintableToken", usdcAddress);

  // 设置金额
  // Long token: 默认 0.001 ETH (1e15 wei)
  const longTokenAmount = process.env.LONG_TOKEN_AMOUNT
    ? bigNumberify(process.env.LONG_TOKEN_AMOUNT)
    : expandDecimals(1, 15);

  // Short token: 默认 10 USDC (10 * 1e6)
  const shortTokenAmount = process.env.SHORT_TOKEN_AMOUNT
    ? bigNumberify(process.env.SHORT_TOKEN_AMOUNT)
    : expandDecimals(10, 6);

  // Execution fee: 0.001 BNB
  const executionFee = expandDecimals(1, 15);

  console.log("\nDeposit amounts:");
  console.log("  Long token amount:", longTokenAmount.toString());
  console.log("  Short token amount:", shortTokenAmount.toString());
  console.log("  Execution fee:", executionFee.toString());

  // 检查和 mint WNT (如果需要)
  const wntBalance = await wnt.balanceOf(wallet.address);
  console.log("\nCurrent WNT balance:", wntBalance.toString());

  if (wntBalance.lt(longTokenAmount)) {
    console.log("Wrapping BNB to WNT...");
    const wntContract = await ethers.getContractAt("WETH9", wntAddress);
    const depositTx = await wntContract.deposit({ value: longTokenAmount.add(executionFee) });
    await depositTx.wait();
    console.log("WNT deposit complete");
  }

  // 检查和 mint USDC (用于测试网)
  const usdcBalance = await usdc.balanceOf(wallet.address);
  console.log("Current USDC balance:", usdcBalance.toString());

  if (usdcBalance.lt(shortTokenAmount)) {
    console.log("Minting USDC for testing...");
    try {
      const mintTx = await usdc.mint(wallet.address, shortTokenAmount);
      await mintTx.wait();
      console.log("USDC minted");
    } catch (e) {
      console.log("Note: Could not mint USDC (may not be a MintableToken)");
    }
  }

  // 授权 Router
  const wntAllowance = await wnt.allowance(wallet.address, router.address);
  if (wntAllowance.lt(longTokenAmount.add(executionFee))) {
    console.log("\nApproving WNT...");
    const approveTx = await wnt.approve(router.address, ethers.constants.MaxUint256);
    await approveTx.wait();
  }

  const usdcAllowance = await usdc.allowance(wallet.address, router.address);
  if (usdcAllowance.lt(shortTokenAmount)) {
    console.log("Approving USDC...");
    const approveTx = await usdc.approve(router.address, ethers.constants.MaxUint256);
    await approveTx.wait();
  }

  // 构建 Deposit 参数
  const params: DepositUtils.CreateDepositParamsStruct = {
    addresses: {
      receiver: wallet.address,
      callbackContract: ethers.constants.AddressZero,
      market: marketAddress,
      initialLongToken: wntAddress,
      longTokenSwapPath: [],
      initialShortToken: usdcAddress,
      shortTokenSwapPath: [],
      uiFeeReceiver: ethers.constants.AddressZero,
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
  const multicallArgs = [
    exchangeRouter.interface.encodeFunctionData("sendWnt", [depositVault.address, longTokenAmount.add(executionFee)]),
    exchangeRouter.interface.encodeFunctionData("sendTokens", [usdcAddress, depositVault.address, shortTokenAmount]),
    exchangeRouter.interface.encodeFunctionData("createDeposit", [params]),
  ];

  // 先执行 callStatic 检查
  console.log("\nSimulating transaction...");
  try {
    const result = await exchangeRouter.callStatic.multicall(multicallArgs, {
      value: longTokenAmount.add(executionFee),
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
    value: longTokenAmount.add(executionFee),
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
