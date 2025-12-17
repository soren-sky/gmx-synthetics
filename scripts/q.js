const { ethers } = require("hardhat");
const keys = require("../utils/keys");
async function main() {
    const ds = await ethers.getContract("DataStore");
    const glvReader = await ethers.getContract("GlvReader");

    // Get GLV
    const glvCount = await ds.getAddressCount(keys.GLV_LIST);
    const glvList = await ds.getAddressValuesAt(keys.GLV_LIST, 0, glvCount);
    const glv = glvList[0];
    console.log("GLV:", glv);

    // Get GLV info
    const glvInfo = await glvReader.getGlvInfo(ds.address, glv);
    const markets = glvInfo.markets || glvInfo[1] || [];
    console.log("Markets in GLV:", markets.length);

    // Get GLV Token balance for each market
    const glvToken = await ethers.getContractAt("GlvToken", glv);

    console.log("\n=== GLV Market Balances ===");
    for (const market of markets) {
        const balance = await glvToken.tokenBalances(market);
        console.log(`Market ${market.slice(0, 10)}...: ${ethers.utils.formatEther(balance)} GM`);
    }

    // GLV shift config
    console.log("\n=== GLV Shift Config ===");
    const maxPriceImpact = await ds.getUint(keys.glvShiftMaxPriceImpactFactorKey(glv));
    console.log("GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR:", maxPriceImpact.toString());
    console.log("= ", parseFloat(maxPriceImpact.toString()) / 1e30 * 100, "%");
}
main();
