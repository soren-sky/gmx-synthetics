const { ethers } = require("hardhat");

async function main() {
    const dataStore = await ethers.getContract("DataStore");
    const reader = await ethers.getContract("Reader");
    const keys = require("../utils/keys");
    
    const toMarket = "0x0D83c8531cF1CA1888B421C35f51b46c1cC7cb67";
    const toMarketInfo = await reader.getMarket(dataStore.address, toMarket);
    
    console.log("Long token:", toMarketInfo.longToken);
    console.log("Short token:", toMarketInfo.shortToken);
    
    const poolLong = await dataStore.getUint(keys.poolAmountKey(toMarket, toMarketInfo.longToken));
    const poolShort = await dataStore.getUint(keys.poolAmountKey(toMarket, toMarketInfo.shortToken));
    
    console.log("Pool Long (raw):", poolLong.toString());
    console.log("Pool Short (raw):", poolShort.toString());
    
    // 检查 USDC decimals
    const usdc = await ethers.getContractAt("IERC20Metadata", toMarketInfo.shortToken);
    const decimals = await usdc.decimals();
    console.log("Short token decimals:", decimals);
    
    console.log("Pool Long (18 dec):", ethers.utils.formatEther(poolLong));
    console.log("Pool Short (" + decimals + " dec):", ethers.utils.formatUnits(poolShort, decimals));
    
    // 估算 USD 价值 (BNB ~$700)
    const poolUsd = poolLong.mul(700).add(poolShort.mul(ethers.utils.parseUnits("1", 18 - decimals)));
    console.log("Total Pool USD (rough):", ethers.utils.formatEther(poolUsd));
}

main();
