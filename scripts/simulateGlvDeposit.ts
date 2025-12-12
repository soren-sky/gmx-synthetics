import hre from "hardhat";
import { bigNumberify, expandDecimals } from "../utils/math";
const { ethers } = hre as any;

async function main() {
  const [wallet] = await ethers.getSigners();
  const glvRouter = await ethers.getContract("GlvRouter");
  const glvVault = await ethers.getContract("GlvVault");

  const glvToken = "0x52044c4Ac7eb4a7e4A87f968655c6985075DF2E5";
  const marketAddress = "0xCCCe7028536b90A2B55E56e0051dbc6AD678dEA1";
  const longTokenAddress = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
  const shortTokenAddress = "0x3BAA5Ac42706Ca6aA52B15951FC4E83eaC063643";

  const longTokenAmount = ethers.utils.parseEther("0.1");
  const shortTokenAmount = ethers.utils.parseUnits("500", 18);
  const executionFee = expandDecimals(2, 16);

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

  const multicallArgs = [
    glvRouter.interface.encodeFunctionData("sendWnt", [glvVault.address, longTokenAmount.add(executionFee)]),
    glvRouter.interface.encodeFunctionData("sendTokens", [shortTokenAddress, glvVault.address, shortTokenAmount]),
    glvRouter.interface.encodeFunctionData("createGlvDeposit", [params]),
  ];

  const totalBnbValue = longTokenAmount.add(executionFee);

  console.log("Simulating GLV deposit...");
  console.log("  Total BNB:", ethers.utils.formatEther(totalBnbValue));

  try {
    const result = await glvRouter.callStatic.multicall(multicallArgs, {
      value: totalBnbValue,
      gasLimit: 8000000,
    });
    console.log("Simulation successful!");
    console.log("Result:", result);
  } catch (e: any) {
    console.error("\nSimulation FAILED!");
    console.error("Error:", e.message);

    // Try to decode error
    if (e.data) {
      console.error("Error data:", e.data);
    }
    if (e.error?.data) {
      console.error("Inner error data:", e.error.data);
    }
  }
}

main().catch(console.error);
