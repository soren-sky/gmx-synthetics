const { ethers } = require("hardhat");
const keys = require("../utils/keys");

async function main() {
    const glvAddress = "0xFe495DBF2dd137b2266f56425B97f09ce0CDEF41";
    const key = keys.glvShiftMaxPriceImpactFactorKey(glvAddress);
    console.log("GLV_SHIFT_MAX_PRICE_IMPACT_FACTOR key:", key);
    
    const dataStore = await ethers.getContract("DataStore");
    
    // Get event filter for SetUint
    const filter = dataStore.filters.SetUint(key);
    const events = await dataStore.queryFilter(filter, 79000000, "latest");
    
    console.log("Found", events.length, "SetUint events for this key:");
    for (const event of events) {
        console.log("  Block:", event.blockNumber);
        console.log("  TxHash:", event.transactionHash);
        console.log("  Value:", event.args.value.toString());
        console.log("");
    }
}

main();
