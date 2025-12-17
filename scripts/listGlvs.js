const { ethers } = require("hardhat");

async function main() {
    const dataStore = await ethers.getContract("DataStore");
    const glvReader = await ethers.getContract("GlvReader");

    // Get GLV list key
    const GLV_LIST_KEY = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("GLV_LIST"));
    const glvCount = await dataStore.getAddressCount(GLV_LIST_KEY);
    console.log("Total GLVs:", glvCount.toString());

    const glvList = await dataStore.getAddressValuesAt(GLV_LIST_KEY, 0, glvCount);
    console.log("\nGLV List:");

    const keys = require("../utils/keys");

    for (let i = 0; i < glvList.length; i++) {
        console.log("  " + i + ": " + glvList[i]);

        // Check GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR for each GLV
        const key = keys.glvShiftMaxPriceImpactFactorKey(glvList[i]);
        const value = await dataStore.getUint(key);
        console.log("     GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR: " + ethers.utils.formatUnits(value, 18) + " (" + value.toString() + ")");
    }
}

main();
