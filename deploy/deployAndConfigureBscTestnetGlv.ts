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
  const btcb = tokens.BTCB;
  const eth = tokens.ETH;
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

  // Calculate market addresses
  // BNB/USD market - WBNB as index and long, USDC as short
  const bnbUsdMarketAddress = getMarketTokenAddress(
    wbnb.address,
    wbnb.address,
    usdc.address,
    DEFAULT_MARKET_TYPE,
    marketFactory.address,
    roleStore.address,
    dataStore.address
  );

  // BTC/USD market - BTCB as index, WBNB as long, USDC as short
  const btcUsdMarketAddress = getMarketTokenAddress(
    btcb.address,
    wbnb.address,
    usdc.address,
    DEFAULT_MARKET_TYPE,
    marketFactory.address,
    roleStore.address,
    dataStore.address
  );

  // ETH/USD market - ETH as index, WBNB as long, USDC as short
  const ethUsdMarketAddress = getMarketTokenAddress(
    eth.address,
    wbnb.address,
    usdc.address,
    DEFAULT_MARKET_TYPE,
    marketFactory.address,
    roleStore.address,
    dataStore.address
  );

  log("BNB/USD market address: %s", bnbUsdMarketAddress);
  log("BTC/USD market address: %s", btcUsdMarketAddress);
  log("ETH/USD market address: %s", ethUsdMarketAddress);

  // Set token transfer gas limit for GLV
  log("Setting token transfer gas limit for GLV...");
  await execute(
    "DataStore",
    { from: deployer, log: true, waitConfirmations: 2 },
    "setUint",
    keys.tokenTransferGasLimit(glvAddress),
    200_000
  );

  // Add markets to GLV
  log("Adding BNB/USD market to GLV...");
  await execute(
    "GlvShiftHandler",
    { from: deployer, log: true, waitConfirmations: 2 },
    "addMarketToGlv",
    glvAddress,
    bnbUsdMarketAddress
  );

  log("Adding BTC/USD market to GLV...");
  await execute(
    "GlvShiftHandler",
    { from: deployer, log: true, waitConfirmations: 2 },
    "addMarketToGlv",
    glvAddress,
    btcUsdMarketAddress
  );

  log("Adding ETH/USD market to GLV...");
  await execute(
    "GlvShiftHandler",
    { from: deployer, log: true, waitConfirmations: 2 },
    "addMarketToGlv",
    glvAddress,
    ethUsdMarketAddress
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
