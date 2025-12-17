const { ethers } = require("hardhat");

async function main() {
    const glvShiftHandler = await ethers.getContract("GlvShiftHandler");
    const dataStore = await ethers.getContract("DataStore");
    
    // 检查 GlvShiftHandler 用的 DataStore
    const handlerDS = await glvShiftHandler.dataStore();
    
    console.log("GlvShiftHandler 的 DataStore:", handlerDS);
    console.log("部署的 DataStore:", dataStore.address);
    console.log("两者相同:", handlerDS.toLowerCase() === dataStore.address.toLowerCase());
}

main();
