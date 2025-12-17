const { ethers } = require("hardhat");
const keys = require("../utils/keys");

async function main() {
    const glvAddress = "0xFe495DBF2dd137b2266f56425B97f09ce0CDEF41";
    const key = keys.glvShiftMaxPriceImpactFactorKey(glvAddress);
    console.log("Key:", key);
    
    const dataStore = await ethers.getContract("DataStore");
    const value = await dataStore.getUint(key);
    console.log("Value:", value.toString());
    console.log("Value (1e18 = 100%):", ethers.utils.formatUnits(value, 18));
}

main();
