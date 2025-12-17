import hre from "hardhat";
import { expandDecimals } from "../utils/math";
import * as keys from "../utils/keys";

const { ethers } = hre as any;

/**
 * 智能 Deposit 脚本 - 为 GLV Shift 计算并存入足够的流动性
 *
 * 自动计算需要多少流动性才能让 GLV shift 成功执行
 */

async function main() {
  const [wallet] = await ethers.getSigners();
  console.log("Wallet address:", wallet.address);
  console.log("Wallet balance:", ethers.utils.formatEther(await wallet.getBalance()), "BNB");

  const dataStore = await ethers.getContract("DataStore");
  const reader = await ethers.getContract("Reader");
  const glvReader = await ethers.getContract("GlvReader");

  // 1. 获取 GLV 信息
  console.log("\n=== 获取 GLV 信息 ===");
  const glvCount = await dataStore.getAddressCount(keys.GLV_LIST);
  if (glvCount.eq(0)) {
    console.error("没有 GLV！请先部署 GLV");
    process.exit(1);
  }

  const glvList = await dataStore.getAddressValuesAt(keys.GLV_LIST, 0, glvCount);
  const glvToken = glvList[0];
  console.log("GLV:", glvToken);

  // 2. 获取 GLV 中的市场
  const glvInfo = await glvReader.getGlvInfo(dataStore.address, glvToken);
  const markets = glvInfo.markets || glvInfo[1] || [];
  console.log("GLV 中的市场数:", markets.length);

  if (markets.length < 2) {
    console.error("GLV 至少需要 2 个市场才能 shift");
    process.exit(1);
  }

  // 3. 获取每个市场的 GM 余额
  console.log("\n=== 检查市场 GM 余额 ===");
  const glvTokenContract = await ethers.getContractAt("GlvToken", glvToken);

  let fromMarket: string | null = null;
  let fromMarketBalance = ethers.BigNumber.from(0);
  let toMarket: string | null = null;
  let toMarketBalance = ethers.BigNumber.from(0);

  for (const market of markets) {
    const balance = await glvTokenContract.tokenBalances(market);
    const marketInfo = await reader.getMarket(dataStore.address, market);
    console.log(`Market ${market.slice(0, 10)}...:`);
    console.log(`  Index: ${marketInfo.indexToken.slice(0, 10)}...`);
    console.log(`  GM Balance: ${ethers.utils.formatEther(balance)}`);

    if (balance.gt(fromMarketBalance)) {
      fromMarket = market;
      fromMarketBalance = balance;
    } else if (balance.lt(toMarketBalance) || toMarket === null) {
      toMarket = market;
      toMarketBalance = balance;
    }
  }

  // 确保 fromMarket 有余额，toMarket 是不同的市场
  if (!fromMarket || fromMarketBalance.eq(0)) {
    console.error("没有市场有 GM 余额！请先 deposit 到某个市场");
    process.exit(1);
  }

  if (fromMarket === toMarket) {
    toMarket = markets.find((m: string) => m.toLowerCase() !== fromMarket!.toLowerCase()) || null;
    if (toMarket) {
      toMarketBalance = await glvTokenContract.tokenBalances(toMarket);
    }
  }

  console.log("\n=== GLV Shift 计划 ===");
  console.log("From Market:", fromMarket);
  console.log("  GM Balance:", ethers.utils.formatEther(fromMarketBalance));
  console.log("To Market:", toMarket);
  console.log("  GM Balance:", ethers.utils.formatEther(toMarketBalance));

  // 4. 检查目标市场的池子流动性
  console.log("\n=== 检查目标市场池子流动性 ===");
  const toMarketInfo = await reader.getMarket(dataStore.address, toMarket);
  const poolLongAmount = await dataStore.getUint(keys.poolAmountKey(toMarket, toMarketInfo.longToken));
  const poolShortAmount = await dataStore.getUint(keys.poolAmountKey(toMarket, toMarketInfo.shortToken));

  console.log("Pool Long (WBNB):", ethers.utils.formatEther(poolLongAmount));
  console.log("Pool Short (USDC):", ethers.utils.formatUnits(poolShortAmount, 6));

  // 5. 获取 GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR
  const maxPriceImpactFactor = await dataStore.getUint(keys.glvShiftMaxPriceImpactFactorKey(glvToken));
  console.log("Max Price Impact:", ethers.utils.formatUnits(maxPriceImpactFactor, 16), "%");

  // 6. 计算需要多少流动性
  // GLV shift 50% 的 GM token
  const shiftAmount = fromMarketBalance.div(2);
  console.log("\nShift Amount (50%):", ethers.utils.formatEther(shiftAmount), "GM");

  // 为了让价格影响 < 1%，池子流动性需要 > shiftAmount * 100
  // (价格影响 ≈ shiftAmount / poolUsd，要求 < 1% 即 0.01)
  const requiredPoolUsd = shiftAmount.mul(100);
  console.log("Required Pool USD (rough estimate):", ethers.utils.formatEther(requiredPoolUsd));

  // 当前池子估值（假设 BNB = $700, USDC = $1）
  const currentPoolUsd = poolLongAmount.mul(700).add(poolShortAmount.mul(ethers.utils.parseUnits("1", 12)));
  console.log("Current Pool USD (rough estimate):", ethers.utils.formatEther(currentPoolUsd));

  if (currentPoolUsd.gte(requiredPoolUsd)) {
    console.log("\n✅ 目标市场流动性足够！可以直接执行 make keeper-glv-shift");
    process.exit(0);
  }

  // 7. 计算需要存入的金额
  const shortfall = requiredPoolUsd.sub(currentPoolUsd);
  console.log("\n流动性缺口:", ethers.utils.formatEther(shortfall), "USD");

  // 建议存入金额（稍微多一点保险）
  // 假设 50% long (BNB) + 50% short (USDC)
  const depositBnb = shortfall.div(2).div(700); // BNB 部分
  const depositUsdc = shortfall.div(2).div(ethers.utils.parseUnits("1", 12)); // USDC 部分

  console.log("\n=== 建议存入金额 ===");
  console.log("LONG (WBNB):", ethers.utils.formatEther(depositBnb.add(expandDecimals(1, 17))), "BNB"); // 额外加 0.1 BNB
  console.log("SHORT (USDC):", ethers.utils.formatUnits(depositUsdc.add(expandDecimals(1000, 6)), 6), "USDC"); // 额外加 1000 USDC

  // 8. 执行 deposit
  console.log("\n=== 开始 Deposit ===");

  const exchangeRouter = await ethers.getContract("ExchangeRouter");
  const router = await ethers.getContract("Router");
  const depositVault = await ethers.getContract("DepositVault");

  const longTokenAddress = toMarketInfo.longToken;
  const shortTokenAddress = toMarketInfo.shortToken;

  // 检查用户 BNB 余额
  const bnbBalance = await wallet.getBalance();
  console.log("你的 BNB 余额:", ethers.utils.formatEther(bnbBalance), "BNB");

  // 使用合理的金额: 0.1 BNB + 100 USDC (测试网，USDC 可以 mint)
  // 可以通过环境变量覆盖
  const longAmountEnv = process.env.LONG_AMOUNT ? parseFloat(process.env.LONG_AMOUNT) : 0.1;
  const shortAmountEnv = process.env.SHORT_AMOUNT ? parseFloat(process.env.SHORT_AMOUNT) : 100;

  const longTokenAmount = ethers.utils.parseEther(longAmountEnv.toString()); // BNB
  const shortTokenAmount = ethers.utils.parseUnits(shortAmountEnv.toString(), 6); // USDC
  const executionFee = expandDecimals(2, 16); // 0.02 BNB

  const totalBnbNeeded = longTokenAmount.add(executionFee);

  console.log("\n计划存入:");
  console.log("  WBNB:", ethers.utils.formatEther(longTokenAmount), "BNB");
  console.log("  USDC:", ethers.utils.formatUnits(shortTokenAmount, 6), "USDC");
  console.log("  Execution Fee:", ethers.utils.formatEther(executionFee), "BNB");
  console.log("  Total BNB needed:", ethers.utils.formatEther(totalBnbNeeded), "BNB");

  if (bnbBalance.lt(totalBnbNeeded.add(expandDecimals(1, 16)))) {
    // 留 0.01 BNB buffer
    console.error("\n❌ BNB 余额不足！");
    console.error("需要:", ethers.utils.formatEther(totalBnbNeeded), "BNB");
    console.error("你有:", ethers.utils.formatEther(bnbBalance), "BNB");
    console.error("\n可以用环境变量减少金额:");
    console.error("  LONG_AMOUNT=0.05 SHORT_AMOUNT=50 make user-deposit-doge");
    process.exit(1);
  }

  console.log("✅ BNB 余额充足");

  // Wrap BNB
  const wntAbi = ["function deposit() external payable"];
  const wntContract = new ethers.Contract(longTokenAddress, wntAbi, wallet);
  console.log("\nWrapping BNB...");
  const wrapTx = await wntContract.deposit({ value: longTokenAmount.add(executionFee) });
  await wrapTx.wait();

  // Mint USDC (测试网)
  const usdcToken = await ethers.getContractAt("MintableToken", shortTokenAddress);
  console.log("Minting USDC...");
  try {
    const mintTx = await usdcToken.mint(wallet.address, shortTokenAmount);
    await mintTx.wait();
  } catch (e) {
    console.log("Note: Could not mint USDC");
  }

  // Approve
  const longToken = await ethers.getContractAt("IERC20", longTokenAddress);
  const shortToken = await ethers.getContractAt("IERC20", shortTokenAddress);

  console.log("Approving tokens...");
  await (await longToken.approve(router.address, ethers.constants.MaxUint256)).wait();
  await (await shortToken.approve(router.address, ethers.constants.MaxUint256)).wait();

  // Build deposit params
  const params = {
    addresses: {
      receiver: wallet.address,
      callbackContract: ethers.constants.AddressZero,
      uiFeeReceiver: ethers.constants.AddressZero,
      market: toMarket,
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

  // Multicall
  const multicallArgs = [
    exchangeRouter.interface.encodeFunctionData("sendWnt", [depositVault.address, longTokenAmount.add(executionFee)]),
    exchangeRouter.interface.encodeFunctionData("sendTokens", [
      shortTokenAddress,
      depositVault.address,
      shortTokenAmount,
    ]),
    exchangeRouter.interface.encodeFunctionData("createDeposit", [params]),
  ];

  console.log("\nSending deposit transaction...");
  const tx = await exchangeRouter.multicall(multicallArgs, {
    value: longTokenAmount.add(executionFee),
    gasLimit: 8000000,
  });

  console.log("Transaction hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("Transaction confirmed! Block:", receipt.blockNumber);

  console.log("\n=== Deposit 请求已创建 ===");
  console.log("等待 keeper 执行后，运行: make keeper-glv-shift");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
