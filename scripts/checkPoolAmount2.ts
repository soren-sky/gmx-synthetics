import hre from "hardhat";
const { ethers } = hre as any;

async function main() {
  const dataStore = await ethers.getContract("DataStore");
  const marketAddress = "0xCCCe7028536b90A2B55E56e0051dbc6AD678dEA1";
  const longToken = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
  const shortToken = "0x3BAA5Ac42706Ca6aA52B15951FC4E83eaC063643";

  // GMX V2 uses Keys.poolAmountKey(market, token)
  // keccak256(abi.encode(POOL_AMOUNT, market, token))
  const POOL_AMOUNT_HASH = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("POOL_AMOUNT"));

  const longPoolKey = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(["bytes32", "address", "address"], [POOL_AMOUNT_HASH, marketAddress, longToken])
  );

  const shortPoolKey = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32", "address", "address"],
      [POOL_AMOUNT_HASH, marketAddress, shortToken]
    )
  );

  console.log("Long pool key:", longPoolKey);
  console.log("Short pool key:", shortPoolKey);

  const longPool = await dataStore.getUint(longPoolKey);
  const shortPool = await dataStore.getUint(shortPoolKey);

  console.log("\nLong pool amount:", ethers.utils.formatEther(longPool), "WBNB");
  console.log("Short pool amount:", ethers.utils.formatUnits(shortPool, 18), "USDC");

  // Also check market token total supply
  const marketToken = await ethers.getContractAt("IERC20", marketAddress);
  const totalSupply = await marketToken.totalSupply();
  console.log("\nGM token total supply:", ethers.utils.formatEther(totalSupply));
}

main().catch(console.error);
