const { ethers } = require("hardhat");

async function main() {
    const dataStore = await ethers.getContract("DataStore");
    const keys = require("../utils/keys");
    
    // GLV
    const glvList = await dataStore.getAddressValuesAt(keys.GLV_LIST, 0, 1);
    const glvToken = glvList[0];
    const glvTokenContract = await ethers.getContractAt("GlvToken", glvToken);
    
    // BNB/USD market
    const bnbMarket = "0x91045A59A2F60306E30512D6883b5587f91e5415";
    const dogeMarket = "0x0D83c8531cF1CA1888B421C35f51b46c1cC7cb67";
    
    const bnbGmBalance = await glvTokenContract.tokenBalances(bnbMarket);
    const dogeGmBalance = await glvTokenContract.tokenBalances(dogeMarket);
    
    console.log("GLV 中的 GM 余额:");
    console.log("  BNB/USD market:", ethers.utils.formatEther(bnbGmBalance), "GM");
    console.log("  DOGE/USD market:", ethers.utils.formatEther(dogeGmBalance), "GM");
    
    // Shift 50% 的 BNB market GM
    const shiftAmount = bnbGmBalance.div(2);
    console.log("\nShift 金额 (50%):", ethers.utils.formatEther(shiftAmount), "GM");
    
    // GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR
    const maxFactor = await dataStore.getUint(keys.glvShiftMaxPriceImpactFactorKey(glvToken));
    console.log("Max Price Impact Factor:", maxFactor.toString(), "=", ethers.utils.formatUnits(maxFactor, 16), "%");
    
    // 简单估算：如果 shift 金额 > 池子流动性，价格影响会很大
    console.log("\n估算:");
    console.log("  Shift ~", ethers.utils.formatEther(shiftAmount), "GM (约 $", ethers.utils.formatEther(shiftAmount), " USD)");
    console.log("  DOGE 池子约 $5698 USD");
    console.log("  价格影响大约:", (parseFloat(ethers.utils.formatEther(shiftAmount)) / 5698 * 100).toFixed(2), "%");
}

main();
