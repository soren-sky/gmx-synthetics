const { ethers } = require("hardhat");

async function main() {
    const dataStore = await ethers.getContract("DataStore");
    const reader = await ethers.getContract("Reader");
    const keys = require("../utils/keys");
    
    const toMarket = "0x0D83c8531cF1CA1888B421C35f51b46c1cC7cb67"; // DOGE/USD
    const toMarketInfo = await reader.getMarket(dataStore.address, toMarket);
    
    const poolLong = await dataStore.getUint(keys.poolAmountKey(toMarket, toMarketInfo.longToken));
    const poolShort = await dataStore.getUint(keys.poolAmountKey(toMarket, toMarketInfo.shortToken));
    
    console.log("DOGE/USD 市场流动性:");
    console.log("  Pool Long (WBNB):", ethers.utils.formatEther(poolLong));
    console.log("  Pool Short (USDC):", ethers.utils.formatUnits(poolShort, 6));
    
    // 检查 GLV 中 DOGE 市场的 GM 余额
    const glvList = await dataStore.getAddressValuesAt(keys.GLV_LIST, 0, 1);
    const glvToken = glvList[0];
    const glvTokenContract = await ethers.getContractAt("GlvToken", glvToken);
    const gmBalance = await glvTokenContract.tokenBalances(toMarket);
    console.log("  GLV 中 DOGE/USD GM 余额:", ethers.utils.formatEther(gmBalance));
}

main();
