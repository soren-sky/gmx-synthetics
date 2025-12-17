const { ethers } = require("hardhat");

async function main() {
    const shiftKey = "0x08b61f563fadfcae81085e680f3199817c480665f9b3f396fd307b1a7d66f9e5";
    
    const glvReader = await ethers.getContract("GlvReader");
    const dataStore = await ethers.getContract("DataStore");
    
    // Try to get shift info
    try {
        const shift = await glvReader.getGlvShift(dataStore.address, shiftKey);
        console.log("Shift GLV:", shift.glv);
        console.log("Shift fromMarket:", shift.fromMarket);
        console.log("Shift toMarket:", shift.toMarket);
    } catch (e) {
        console.log("Shift 已被清理或不存在");
    }
    
    // 列出所有 GLV 并检查它们的 GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR
    const keys = require("../utils/keys");
    const glvCount = await dataStore.getAddressCount(keys.GLV_LIST);
    console.log("\nGLV 数量:", glvCount.toString());
    
    const glvList = await dataStore.getAddressValuesAt(keys.GLV_LIST, 0, glvCount);
    for (const glv of glvList) {
        const key = keys.glvShiftMaxPriceImpactFactorKey(glv);
        const value = await dataStore.getUint(key);
        console.log("GLV:", glv);
        console.log("  GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR:", value.toString());
        console.log("  Key:", key);
    }
}

main();
