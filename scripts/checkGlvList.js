const { ethers } = require("hardhat");
const keys = require("../utils/keys");

async function main() {
    const dataStore = await ethers.getContract("DataStore");
    
    // Try both methods to get GLV_LIST key
    const key1 = keys.GLV_LIST;
    const key2 = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("GLV_LIST"));
    const key3 = ethers.utils.solidityKeccak256(["string"], ["GLV_LIST"]);
    
    console.log("keys.GLV_LIST:", key1);
    console.log("keccak256(toUtf8Bytes):", key2);
    console.log("solidityKeccak256:", key3);
    
    const count1 = await dataStore.getAddressCount(key1);
    const count2 = await dataStore.getAddressCount(key2);
    const count3 = await dataStore.getAddressCount(key3);
    
    console.log("\nCounts:");
    console.log("  keys.GLV_LIST:", count1.toString());
    console.log("  keccak256(toUtf8Bytes):", count2.toString());
    console.log("  solidityKeccak256:", count3.toString());

    // Get GLVs from correct key
    if (count1.gt(0)) {
        const glvs = await dataStore.getAddressValuesAt(key1, 0, count1);
        console.log("\nGLVs:", glvs);
    }
}

main();
