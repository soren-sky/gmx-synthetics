import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as keys from "../utils/keys";
import { DEFAULT_MARKET_TYPE, getMarketTokenAddress } from "../utils/market";
import { getGlvAddress } from "../utils/glv";

const func = async ({ deployments, getNamedAccounts, gmx }: HardhatRuntimeEnvironment) => {
  const { execute, get, log } = deployments;

  const { deployer } = await getNamedAccounts();

  const tokens = await gmx.getTokens();

  const wbnb = tokens.WBNB;
  const usdc = tokens.USDC;
  const doge = tokens.DOGE;
  const glvType = ethers.constants.HashZero;

  // Create GLV for WBNB-USDC markets
  const glvName = "GMX Liquidity Vault [WBNB-USDC]";
  const glvSymbol = "GLV [WBNB-USDC]";

  log("Creating GLV: %s", glvName);
  await execute(
    "GlvFactory",
    { from: deployer, log: true, waitConfirmations: 2 },
    "createGlv",
    wbnb.address,
    usdc.address,
    glvType,
    glvName,
    glvSymbol
  );

  const dataStore = await get("DataStore");
  const roleStore = await get("RoleStore");
  const glvFactory = await get("GlvFactory");
  const marketFactory = await get("MarketFactory");

  // Calculate GLV address
  const glvAddress = getGlvAddress(
    wbnb.address,
    usdc.address,
    glvType,
    glvName,
    glvSymbol,
    glvFactory.address,
    roleStore.address,
    dataStore.address
  );

  log("GLV address: %s", glvAddress);

  // Calculate market addresses - must match the markets configured in config/markets.ts
  // All markets in this GLV must use WBNB as longToken and USDC as shortToken

  // BNB/USD market - WBNB as index and long, USDC as short (Standard Market)
  const bnbUsdMarketAddress = getMarketTokenAddress(
    wbnb.address,
    wbnb.address,
    usdc.address,
    DEFAULT_MARKET_TYPE,
    marketFactory.address,
    roleStore.address,
    dataStore.address
  );

  // DOGE/USD market - DOGE as index, WBNB as long, USDC as short (Synthetic Market)
  const dogeUsdMarketAddress = getMarketTokenAddress(
    doge.address,
    wbnb.address,
    usdc.address,
    DEFAULT_MARKET_TYPE,
    marketFactory.address,
    roleStore.address,
    dataStore.address
  );

  log("BNB/USD market address: %s", bnbUsdMarketAddress);
  log("DOGE/USD market address: %s", dogeUsdMarketAddress);

  // Set token transfer gas limit for GLV
  log("Setting token transfer gas limit for GLV...");
  await execute(
    "DataStore",
    { from: deployer, log: true, waitConfirmations: 2 },
    "setUint",
    keys.tokenTransferGasLimit(glvAddress),
    200_000
  );

  // Set GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR
  // GMX uses FLOAT_PRECISION = 1e30, so:
  //   1% = 0.01 * 1e30 = 1e28
  //   5% = 0.05 * 1e30 = 5e28
  // We use 5% to allow reasonable shift operations on low-liquidity pools
  log("Setting GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR to 5%...");
  await execute(
    "DataStore",
    { from: deployer, log: true, waitConfirmations: 2 },
    "setUint",
    keys.glvShiftMaxPriceImpactFactorKey(glvAddress),
    ethers.BigNumber.from("5").mul(ethers.BigNumber.from("10").pow(28)) // 5% = 5e28
  );

  // Add markets to GLV (all must have WBNB as longToken and USDC as shortToken)
  log("Adding BNB/USD market to GLV...");
  await execute(
    "GlvShiftHandler",
    { from: deployer, log: true, waitConfirmations: 2 },
    "addMarketToGlv",
    glvAddress,
    bnbUsdMarketAddress
  );

  log("Adding DOGE/USD market to GLV...");
  await execute(
    "GlvShiftHandler",
    { from: deployer, log: true, waitConfirmations: 2 },
    "addMarketToGlv",
    glvAddress,
    dogeUsdMarketAddress
  );

  log("GLV deployment and configuration complete!");
};

func.skip = async ({ network }) => {
  // Only run on bscTestnet
  return network.name !== "bscTestnet";
};
func.runAtTheEnd = true;
func.tags = ["BscTestnetGlv"];
func.dependencies = ["GlvFactory", "GlvShiftHandler", "Tokens", "DataStore", "Roles", "Markets"];
export default func;
